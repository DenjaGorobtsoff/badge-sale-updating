import {
  Link,
  useFetcher,
  useLoaderData,
} from "react-router";

import {
  useEffect,
  useMemo,
  useState,
} from "react";

import prisma from "../db.server";
import { authenticate } from "../shopify.server";

const SALE_BADGE_GID =
  "gid://shopify/Metaobject/92904096052";

const BADGE_NAMESPACE = "custom";
const BADGE_KEY = "product_badges";

const PAGE_SIZE = 250;
const LIST_PAGE_SIZE = 50;

const VALID_FILTERS = new Set([
  "ALL",
  "ADD_SALE",
  "REMOVE_SALE",
]);

function parseBadges(value) {
  if (!value) {
    return [];
  }

  try {
    const parsed = JSON.parse(value);

    return Array.isArray(parsed)
      ? parsed.filter(
        (item) =>
          typeof item === "string",
      )
      : [];
  } catch {
    return [];
  }
}

function analyseVariant(variant) {
  const badges = parseBadges(
    variant.metafield?.value,
  );

  const price = Number(
    variant.price,
  );

  const compareAtPrice =
    variant.compareAtPrice !== null
      ? Number(
        variant.compareAtPrice,
      )
      : null;

  const isOnSale =
    compareAtPrice !== null &&
    compareAtPrice > price;

  const hasSaleBadge =
    badges.includes(
      SALE_BADGE_GID,
    );

  let action = "NONE";

  if (
    isOnSale &&
    !hasSaleBadge
  ) {
    action = "ADD_SALE";
  }

  if (
    !isOnSale &&
    hasSaleBadge
  ) {
    action = "REMOVE_SALE";
  }

  return {
    isOnSale,
    hasSaleBadge,
    action,
  };
}

function numericId(gid) {
  return gid
    ?.split("/")
    .pop();
}

function normalizePage(value) {
  const page =
    Number.parseInt(
      value || "1",
      10,
    );

  return Number.isFinite(page) &&
  page > 0
    ? page
    : 1;
}

function serializeJob(job) {
  if (!job) {
    return null;
  }

  return {
    id: job.id,
    shop: job.shop,
    type: job.type,
    status: job.status,
    checked: job.checked,
    changes: job.changes,
    addCount: job.addCount,
    removeCount:
    job.removeCount,
    failed: job.failed,

    startedAt:
      job.startedAt
        ?.toISOString?.() ??
      job.startedAt,

    finishedAt:
      job.finishedAt
        ?.toISOString?.() ??
      job.finishedAt,

    lastError:
    job.lastError,
  };
}

/*
|--------------------------------------------------------------------------
| LOADER
|--------------------------------------------------------------------------
|
| Reads the latest Dry Run job from PostgreSQL.
| It does NOT scan Shopify here.
|
| It also loads only 50 detected changes at a time.
|
*/

export const loader =
  async ({ request }) => {
    const {
      session,
    } =
      await authenticate.admin(
        request,
      );

    const url =
      new URL(request.url);

    const page =
      normalizePage(
        url.searchParams.get(
          "page",
        ),
      );

    const requestedFilter =
      (
        url.searchParams.get(
          "filter",
        ) || "ALL"
      ).toUpperCase();

    const filter =
      VALID_FILTERS.has(
        requestedFilter,
      )
        ? requestedFilter
        : "ALL";

    /*
     * Get the latest Dry Run.
     */
    const job =
      await prisma.saleBadgeSyncJob.findFirst(
        {
          where: {
            shop:
            session.shop,

            type:
              "DRY_RUN",
          },

          orderBy: {
            startedAt:
              "desc",
          },
        },
      );

    /*
     * No Dry Run has been started yet.
     */
    if (!job) {
      return {
        job: null,

        affectedProducts: 0,

        items: [],

        listTotal: 0,

        page: 1,

        totalPages: 0,

        filter,

        storeHandle:
          session.shop.replace(
            ".myshopify.com",
            "",
          ),
      };
    }

    const itemWhere = {
      jobId: job.id,

      ...(filter !== "ALL"
        ? {
          action:
          filter,
        }
        : {}),
    };

    /*
     * Load:
     *
     * 1. Number of detected changes.
     * 2. Current list page.
     * 3. Unique products affected.
     */
    const [
      listTotal,
      items,
      distinctProducts,
    ] =
      await prisma.$transaction(
        [
          prisma.saleBadgeSyncItem.count(
            {
              where:
              itemWhere,
            },
          ),

          prisma.saleBadgeSyncItem.findMany(
            {
              where:
              itemWhere,

              orderBy: [
                {
                  productTitle:
                    "asc",
                },

                {
                  variantTitle:
                    "asc",
                },
              ],

              skip:
                (page - 1) *
                LIST_PAGE_SIZE,

              take:
              LIST_PAGE_SIZE,
            },
          ),

          prisma.saleBadgeSyncItem.findMany(
            {
              where: {
                jobId:
                job.id,
              },

              distinct: [
                "productId",
              ],

              select: {
                productId:
                  true,
              },
            },
          ),
        ],
      );

    const totalPages =
      Math.ceil(
        listTotal /
        LIST_PAGE_SIZE,
      );

    return {
      job:
        serializeJob(job),

      /*
       * Number of UNIQUE products
       * that contain at least one
       * problematic variant.
       */
      affectedProducts:
      distinctProducts.length,

      items:
        items.map(
          (item) => ({
            ...item,

            createdAt:
              item.createdAt.toISOString(),

            variantNumericId:
              numericId(
                item.variantId,
              ),

            productNumericId:
              numericId(
                item.productId,
              ),
          }),
        ),

      listTotal,

      page,

      totalPages,

      filter,

      storeHandle:
        session.shop.replace(
          ".myshopify.com",
          "",
        ),
    };
  };

/*
|--------------------------------------------------------------------------
| ACTION
|--------------------------------------------------------------------------
|
| Handles:
|
| startDryRun
| processDryRun
|
*/

export const action =
  async ({ request }) => {
    const {
      admin,
      session,
    } =
      await authenticate.admin(
        request,
      );

    const formData =
      await request.formData();

    const intent =
      formData.get(
        "intent",
      );

    /*
    |--------------------------------------------------------------------------
    | START FULL DRY RUN
    |--------------------------------------------------------------------------
    */

    if (
      intent ===
      "startDryRun"
    ) {
      /*
       * Prevent two Dry Runs from
       * running simultaneously.
       */
      const runningJob =
        await prisma.saleBadgeSyncJob.findFirst(
          {
            where: {
              shop:
              session.shop,

              type:
                "DRY_RUN",

              status:
                "RUNNING",
            },

            orderBy: {
              startedAt:
                "desc",
            },
          },
        );

      /*
       * If a previous scan is still
       * running, return it instead
       * of creating another one.
       */
      if (runningJob) {
        return {
          success: true,

          intent,

          message:
            "A dry run is already in progress. Resuming it.",

          job:
            serializeJob(
              runningJob,
            ),
        };
      }

      /*
       * Create new Dry Run.
       */
      const job =
        await prisma.saleBadgeSyncJob.create(
          {
            data: {
              shop:
              session.shop,

              type:
                "DRY_RUN",

              status:
                "RUNNING",
            },
          },
        );

      return {
        success: true,

        intent,

        message:
          "Full catalog dry run started.",

        job:
          serializeJob(job),
      };
    }

    /*
    |--------------------------------------------------------------------------
    | PROCESS ONE SHOPIFY PAGE
    |--------------------------------------------------------------------------
    |
    | One request = maximum 250 variants.
    |
    | This is intentional.
    |
    | We do NOT attempt to process
    | 50,000 variants in one Vercel request.
    |
    */

    if (
      intent ===
      "processDryRun"
    ) {
      const jobId =
        formData.get(
          "jobId",
        );

      if (
        !jobId ||
        typeof jobId !==
        "string"
      ) {
        return {
          success: false,

          intent,

          message:
            "Missing dry run job ID.",
        };
      }

      /*
       * Make sure this job belongs
       * to the current Shopify store.
       */
      const job =
        await prisma.saleBadgeSyncJob.findFirst(
          {
            where: {
              id: jobId,

              shop:
              session.shop,

              type:
                "DRY_RUN",
            },
          },
        );

      if (!job) {
        return {
          success: false,

          intent,

          message:
            "Dry run job was not found.",
        };
      }

      /*
       * Don't continue finished jobs.
       */
      if (
        job.status !==
        "RUNNING"
      ) {
        return {
          success:
            job.status ===
            "COMPLETED",

          intent,

          message:
            `Dry run is ${job.status.toLowerCase()}.`,

          job:
            serializeJob(job),
        };
      }

      try {
        /*
         * Read next 250 variants.
         */
        const response =
          await admin.graphql(
            `#graphql
              query FullSaleBadgeDryRun(
                $first: Int!
                $after: String
              ) {
                productVariants(
                  first: $first
                  after: $after
                  sortKey: ID
                ) {
                  nodes {
                    id
                    title
                    sku
                    price
                    compareAtPrice

                    product {
                      id
                      title
                    }

                    metafield(
                      namespace: "${BADGE_NAMESPACE}"
                      key: "${BADGE_KEY}"
                    ) {
                      id
                      type
                      value
                    }
                  }

                  pageInfo {
                    hasNextPage
                    endCursor
                  }
                }
              }
            `,
            {
              variables: {
                first:
                PAGE_SIZE,

                after:
                  job.cursor ||
                  null,
              },
            },
          );

        const json =
          await response.json();

        /*
         * Shopify GraphQL errors.
         */
        if (
          json.errors?.length
        ) {
          throw new Error(
            json.errors
              .map(
                (error) =>
                  error.message,
              )
              .join("; "),
          );
        }

        const connection =
          json.data
            ?.productVariants;

        if (!connection) {
          throw new Error(
            "Shopify response did not contain productVariants.",
          );
        }

        let addCount = 0;
        let removeCount = 0;

        const problemItems =
          [];

        /*
         * Analyse every variant.
         */
        for (
          const variant
          of connection.nodes
          ) {
          const analysis =
            analyseVariant(
              variant,
            );

          /*
           * Correct state.
           *
           * We don't need to save
           * this variant in DB.
           */
          if (
            analysis.action ===
            "NONE"
          ) {
            continue;
          }

          if (
            analysis.action ===
            "ADD_SALE"
          ) {
            addCount += 1;
          }

          if (
            analysis.action ===
            "REMOVE_SALE"
          ) {
            removeCount += 1;
          }

          /*
           * Save only problematic variants.
           */
          problemItems.push(
            {
              jobId:
              job.id,

              variantId:
              variant.id,

              productId:
              variant.product.id,

              productTitle:
              variant.product.title,

              variantTitle:
              variant.title,

              sku:
                variant.sku ||
                null,

              price:
                String(
                  variant.price,
                ),

              compareAtPrice:
                variant.compareAtPrice !==
                null
                  ? String(
                    variant.compareAtPrice,
                  )
                  : null,

              action:
              analysis.action,

              isOnSale:
              analysis.isOnSale,

              hasSaleBadge:
              analysis.hasSaleBadge,
            },
          );
        }

        const pageChecked =
          connection.nodes.length;

        const pageChanges =
          problemItems.length;

        const completed =
          !connection.pageInfo
            .hasNextPage;

        /*
         * Save:
         *
         * - problem variants
         * - new cursor
         * - statistics
         *
         * inside one DB transaction.
         */
        const updatedJob =
          await prisma.$transaction(
            async (tx) => {
              if (
                problemItems.length >
                0
              ) {
                await tx.saleBadgeSyncItem.createMany(
                  {
                    data:
                    problemItems,

                    /*
                     * Prevent duplicates
                     * if the same page is
                     * accidentally processed
                     * twice.
                     */
                    skipDuplicates:
                      true,
                  },
                );
              }

              return tx.saleBadgeSyncJob.update(
                {
                  where: {
                    id:
                    job.id,
                  },

                  data: {
                    cursor:
                      connection
                        .pageInfo
                        .endCursor ||
                      job.cursor,

                    checked: {
                      increment:
                      pageChecked,
                    },

                    changes: {
                      increment:
                      pageChanges,
                    },

                    addCount: {
                      increment:
                      addCount,
                    },

                    removeCount: {
                      increment:
                      removeCount,
                    },

                    status:
                      completed
                        ? "COMPLETED"
                        : "RUNNING",

                    finishedAt:
                      completed
                        ? new Date()
                        : null,

                    lastError:
                      null,
                  },
                },
              );
            },
          );

        return {
          success: true,

          intent,

          message:
            completed
              ? "Full catalog dry run completed."
              : `Checked another ${pageChecked} variants.`,

          job:
            serializeJob(
              updatedJob,
            ),

          page: {
            checked:
            pageChecked,

            changes:
            pageChanges,

            add:
            addCount,

            remove:
            removeCount,

            hasNextPage:
            connection
              .pageInfo
              .hasNextPage,
          },
        };
      } catch (error) {
        console.error(
          "Full dry run error:",
          error,
        );

        const message =
          error instanceof
          Error
            ? error.message
            : "Unknown dry run error.";

        /*
         * Store the failure in DB.
         */
        const failedJob =
          await prisma.saleBadgeSyncJob.update(
            {
              where: {
                id:
                job.id,
              },

              data: {
                status:
                  "FAILED",

                failed: {
                  increment:
                    1,
                },

                lastError:
                message,

                finishedAt:
                  new Date(),
              },
            },
          );

        return {
          success: false,

          intent,

          message,

          job:
            serializeJob(
              failedJob,
            ),
        };
      }
    }

    return {
      success: false,

      intent,

      message:
        "Unknown action.",
    };
  };

/*
|--------------------------------------------------------------------------
| PAGE
|--------------------------------------------------------------------------
*/

export default function SaleSyncPage() {
  const {
    job,
    affectedProducts,
    items,
    listTotal,
    page,
    totalPages,
    filter,
    storeHandle,
  } =
    useLoaderData();

  const scanFetcher =
    useFetcher();

  const [
    autoRunning,
    setAutoRunning,
  ] =
    useState(false);

  /*
   * Prefer the newest job state returned
   * by useFetcher over the loader state.
   */
  const liveJob =
    scanFetcher.data
      ?.job ||
    job;

  const isSubmitting =
    scanFetcher.state !==
    "idle";

  const progressMessage =
    scanFetcher.data
      ?.message;

  /*
  |--------------------------------------------------------------------------
  | AUTOMATIC PAGE PROCESSING
  |--------------------------------------------------------------------------
  |
  | Browser sends:
  |
  | processDryRun
  |       ↓
  | 250 variants
  |       ↓
  | response
  |       ↓
  | processDryRun
  |       ↓
  | next 250
  |
  */

  useEffect(() => {
    if (!autoRunning) {
      return;
    }

    /*
     * Wait until previous request
     * has finished.
     */
    if (
      scanFetcher.state !==
      "idle"
    ) {
      return;
    }

    /*
     * Stop automatically when job
     * is completed or failed.
     */
    if (
      !liveJob ||
      liveJob.status !==
      "RUNNING"
    ) {
      setAutoRunning(
        false,
      );

      return;
    }

    /*
     * Small pause between Shopify requests.
     */
    const timer =
      window.setTimeout(
        () => {
          scanFetcher.submit(
            {
              intent:
                "processDryRun",

              jobId:
              liveJob.id,
            },
            {
              method:
                "post",
            },
          );
        },
        250,
      );

    return () =>
      window.clearTimeout(
        timer,
      );
  }, [
    autoRunning,
    liveJob,
    scanFetcher,
    scanFetcher.state,
  ]);

  const status =
    liveJob?.status ||
    "NOT_STARTED";

  const canStart =
    !liveJob ||
    [
      "COMPLETED",
      "FAILED",
    ].includes(
      liveJob.status,
    );

  const canResume =
    liveJob?.status ===
    "RUNNING";

  /*
   * "Showing 1-50 of 3421"
   */
  const shownRange =
    useMemo(() => {
      if (
        listTotal === 0
      ) {
        return "0";
      }

      const from =
        (page - 1) *
        LIST_PAGE_SIZE +
        1;

      const to =
        Math.min(
          page *
          LIST_PAGE_SIZE,
          listTotal,
        );

      return `${from}-${to}`;
    }, [
      page,
      listTotal,
    ]);

  /*
   * Preserve filter during pagination.
   */
  const buildListUrl =
    (
      nextPage,
      nextFilter = filter,
    ) => {
      const params =
        new URLSearchParams();

      params.set(
        "page",
        String(nextPage),
      );

      params.set(
        "filter",
        nextFilter,
      );

      return `?${params.toString()}`;
    };

  return (
    <s-page heading="SALE badge sync">
      <s-section heading="Full catalog dry run">
        <s-paragraph>
          This scan does not change Shopify data.
          It checks the full variant catalog in pages
          of 250 and stores only variants that require
          a SALE badge change.
        </s-paragraph>

        {/* CONTROLS */}

        <div
          style={{
            display: "flex",
            gap: "12px",
            flexWrap: "wrap",
            marginTop: "18px",
            marginBottom: "18px",
          }}
        >
          {canStart && (
            <button
              type="button"
              disabled={
                isSubmitting
              }
              onClick={() => {
                setAutoRunning(
                  true,
                );

                scanFetcher.submit(
                  {
                    intent:
                      "startDryRun",
                  },
                  {
                    method:
                      "post",
                  },
                );
              }}
              style={
                primaryButtonStyle
              }
            >
              {isSubmitting
                ? "Starting..."
                : "Start full dry run"}
            </button>
          )}

          {canResume &&
            !autoRunning && (
              <button
                type="button"
                disabled={
                  isSubmitting
                }
                onClick={() => {
                  setAutoRunning(
                    true,
                  );
                }}
                style={
                  primaryButtonStyle
                }
              >
                Resume dry run
              </button>
            )}

          {autoRunning && (
            <button
              type="button"
              onClick={() => {
                setAutoRunning(
                  false,
                );
              }}
              style={
                secondaryButtonStyle
              }
            >
              Pause browser processing
            </button>
          )}
        </div>

        {/* STATISTICS */}

        <div
          style={{
            display: "grid",

            gridTemplateColumns:
              "repeat(auto-fit, minmax(160px, 1fr))",

            gap: "12px",

            marginBottom:
              "20px",
          }}
        >
          <StatCard
            label="Status"
            value={
              status
            }
          />

          <StatCard
            label="Variants checked"
            value={
              liveJob?.checked ??
              0
            }
          />

          <StatCard
            label="Products affected"
            value={
              affectedProducts
            }
          />

          <StatCard
            label="Variants to change"
            value={
              liveJob?.changes ??
              0
            }
          />

          <StatCard
            label="ADD SALE"
            value={
              liveJob?.addCount ??
              0
            }
          />

          <StatCard
            label="REMOVE SALE"
            value={
              liveJob?.removeCount ??
              0
            }
          />

          <StatCard
            label="Errors"
            value={
              liveJob?.failed ??
              0
            }
          />
        </div>

        {/* PROGRESS */}

        {(progressMessage ||
          autoRunning) && (
          <div
            style={{
              marginBottom:
                "18px",

              padding:
                "12px 14px",

              border:
                "1px solid #c9cccf",

              borderRadius:
                "8px",

              background:
                "#f6f6f7",
            }}
          >
            {autoRunning &&
            status ===
            "RUNNING"
              ? "Scanning catalog automatically. Keep this page open."
              : progressMessage}
          </div>
        )}

        {/* ERROR */}

        {liveJob?.lastError && (
          <div
            style={{
              marginBottom:
                "18px",

              padding:
                "12px 14px",

              border:
                "1px solid #d82c0d",

              borderRadius:
                "8px",

              background:
                "#fff4f4",
            }}
          >
            <strong>
              Last error:
            </strong>{" "}
            {
              liveJob.lastError
            }
          </div>
        )}
      </s-section>

      {/* RESULTS */}

      <s-section heading="Detected changes">
        {!job ? (
          <s-paragraph>
            Run the full dry run first. No Shopify data
            will be changed.
          </s-paragraph>
        ) : (
          <>
            {/* FILTERS */}

            <div
              style={{
                display:
                  "flex",

                gap:
                  "10px",

                flexWrap:
                  "wrap",

                marginBottom:
                  "16px",
              }}
            >
              <FilterLink
                active={
                  filter ===
                  "ALL"
                }
                to={
                  buildListUrl(
                    1,
                    "ALL",
                  )
                }
              >
                All (
                {
                  job.changes
                }
                )
              </FilterLink>

              <FilterLink
                active={
                  filter ===
                  "ADD_SALE"
                }
                to={
                  buildListUrl(
                    1,
                    "ADD_SALE",
                  )
                }
              >
                ADD SALE (
                {
                  job.addCount
                }
                )
              </FilterLink>

              <FilterLink
                active={
                  filter ===
                  "REMOVE_SALE"
                }
                to={
                  buildListUrl(
                    1,
                    "REMOVE_SALE",
                  )
                }
              >
                REMOVE SALE (
                {
                  job.removeCount
                }
                )
              </FilterLink>
            </div>

            <div
              style={{
                marginBottom:
                  "12px",
              }}
            >
              Showing{" "}
              {shownRange} of{" "}
              {listTotal}
            </div>

            {/* TABLE */}

            {items.length ===
            0 ? (
              <div
                style={{
                  padding:
                    "20px",

                  border:
                    "1px solid #ddd",

                  borderRadius:
                    "8px",
                }}
              >
                No detected changes
                for this filter.
              </div>
            ) : (
              <div
                style={{
                  overflowX:
                    "auto",
                }}
              >
                <table
                  style={{
                    width:
                      "100%",

                    borderCollapse:
                      "collapse",
                  }}
                >
                  <thead>
                  <tr>
                    <th
                      style={
                        cellStyle
                      }
                    >
                      Product
                    </th>

                    <th
                      style={
                        cellStyle
                      }
                    >
                      Variant
                    </th>

                    <th
                      style={
                        cellStyle
                      }
                    >
                      SKU
                    </th>

                    <th
                      style={
                        cellStyle
                      }
                    >
                      Price
                    </th>

                    <th
                      style={
                        cellStyle
                      }
                    >
                      Compare at
                    </th>

                    <th
                      style={
                        cellStyle
                      }
                    >
                      On sale?
                    </th>

                    <th
                      style={
                        cellStyle
                      }
                    >
                      SALE badge?
                    </th>

                    <th
                      style={
                        cellStyle
                      }
                    >
                      Action
                    </th>

                    <th
                      style={
                        cellStyle
                      }
                    >
                      Admin
                    </th>
                  </tr>
                  </thead>

                  <tbody>
                  {items.map(
                    (item) => (
                      <tr
                        key={
                          item.id
                        }
                      >
                        <td
                          style={
                            cellStyle
                          }
                        >
                          {
                            item.productTitle
                          }
                        </td>

                        <td
                          style={
                            cellStyle
                          }
                        >
                          {
                            item.variantTitle
                          }
                        </td>

                        <td
                          style={
                            cellStyle
                          }
                        >
                          {item.sku ||
                            "-"}
                        </td>

                        <td
                          style={
                            cellStyle
                          }
                        >
                          {
                            item.price
                          }
                        </td>

                        <td
                          style={
                            cellStyle
                          }
                        >
                          {item.compareAtPrice ||
                            "-"}
                        </td>

                        <td
                          style={
                            cellStyle
                          }
                        >
                          {item.isOnSale
                            ? "YES"
                            : "NO"}
                        </td>

                        <td
                          style={
                            cellStyle
                          }
                        >
                          {item.hasSaleBadge
                            ? "YES"
                            : "NO"}
                        </td>

                        <td
                          style={
                            cellStyle
                          }
                        >
                          <strong>
                            {
                              item.action
                            }
                          </strong>
                        </td>

                        <td
                          style={
                            cellStyle
                          }
                        >
                          <a
                            href={`https://admin.shopify.com/store/${storeHandle}/products/${item.productNumericId}/variants/${item.variantNumericId}`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            Open
                          </a>
                        </td>
                      </tr>
                    ),
                  )}
                  </tbody>
                </table>
              </div>
            )}

            {/* PAGINATION */}

            {totalPages >
              1 && (
                <div
                  style={{
                    display:
                      "flex",

                    alignItems:
                      "center",

                    gap:
                      "12px",

                    marginTop:
                      "18px",
                  }}
                >
                  {page > 1 ? (
                    <Link
                      to={
                        buildListUrl(
                          page -
                          1,
                        )
                      }
                    >
                      Previous
                    </Link>
                  ) : (
                    <span>
                    Previous
                  </span>
                  )}

                  <strong>
                    Page {page} of{" "}
                    {totalPages}
                  </strong>

                  {page <
                  totalPages ? (
                    <Link
                      to={
                        buildListUrl(
                          page +
                          1,
                        )
                      }
                    >
                      Next
                    </Link>
                  ) : (
                    <span>
                    Next
                  </span>
                  )}
                </div>
              )}
          </>
        )}
      </s-section>
    </s-page>
  );
}

/*
|--------------------------------------------------------------------------
| SMALL UI COMPONENTS
|--------------------------------------------------------------------------
*/

function StatCard({
                    label,
                    value,
                  }) {
  return (
    <div
      style={{
        padding:
          "14px",

        border:
          "1px solid #ddd",

        borderRadius:
          "8px",

        background:
          "#fff",
      }}
    >
      <div
        style={{
          fontSize:
            "12px",

          opacity:
            0.7,

          marginBottom:
            "6px",
        }}
      >
        {label}
      </div>

      <strong
        style={{
          fontSize:
            "20px",
        }}
      >
        {value}
      </strong>
    </div>
  );
}

function FilterLink({
                      active,
                      to,
                      children,
                    }) {
  return (
    <Link
      to={to}
      style={{
        display:
          "inline-block",

        padding:
          "8px 12px",

        border:
          "1px solid #c9cccf",

        borderRadius:
          "8px",

        textDecoration:
          "none",

        fontWeight:
          active
            ? 700
            : 400,

        background:
          active
            ? "#f1f8f5"
            : "#fff",
      }}
    >
      {children}
    </Link>
  );
}

const primaryButtonStyle = {
  padding:
    "10px 16px",

  fontWeight:
    600,

  cursor:
    "pointer",
};

const secondaryButtonStyle = {
  padding:
    "10px 16px",

  cursor:
    "pointer",
};

const cellStyle = {
  padding:
    "10px",

  borderBottom:
    "1px solid #ddd",

  textAlign:
    "left",

  whiteSpace:
    "nowrap",
};
