import { useEffect, useMemo, useState } from "react";
import {
  useFetcher,
  useLoaderData,
  useNavigate,
  useSearchParams,
} from "react-router";

import { authenticate } from "../shopify.server";
import db from "../db.server";

/*
|--------------------------------------------------------------------------
| Configuration
|--------------------------------------------------------------------------
*/

const SALE_BADGE_GID =
  "gid://shopify/Metaobject/92904096052";

const BADGE_NAMESPACE = "custom";
const BADGE_KEY = "product_badges";

const SHOPIFY_PAGE_SIZE = 250;
const RESULT_PAGE_SIZE = 50;
const APPLY_BATCH_SIZE = 25;

/*
|--------------------------------------------------------------------------
| Helpers
|--------------------------------------------------------------------------
*/

function parseBadges(value) {
  if (!value) {
    return [];
  }

  try {
    const parsed = JSON.parse(value);

    return Array.isArray(parsed)
      ? parsed
      : [];
  } catch {
    return [];
  }
}

function getVariantState(variant) {
  const badges = parseBadges(
    variant.metafield?.value,
  );

  const price = Number(
    variant.price,
  );

  const compareAtPrice =
    variant.compareAtPrice !== null &&
    variant.compareAtPrice !== undefined
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
    action =
      "REMOVE_SALE";
  }

  return {
    badges,
    price,
    compareAtPrice,
    isOnSale,
    hasSaleBadge,
    action,
  };
}

/*
|--------------------------------------------------------------------------
| Loader
|--------------------------------------------------------------------------
*/

export async function loader({
                               request,
                             }) {
  const { session } =
    await authenticate.admin(
      request,
    );

  const url = new URL(
    request.url,
  );

  const page = Math.max(
    Number(
      url.searchParams.get(
        "page",
      ) || 1,
    ),
    1,
  );

  const skip =
    (page - 1) *
    RESULT_PAGE_SIZE;

  const job =
    await db.saleBadgeSyncJob.findFirst(
      {
        where: {
          shop: session.shop,
        },

        orderBy: {
          createdAt:
            "desc",
        },
      },
    );

  if (!job) {
    return {
      job: null,
      items: [],
      affectedProducts:
        0,
      page: 1,
      totalPages: 0,
    };
  }

  const [
    items,
    affectedProductsRows,
  ] =
    await Promise.all([
      db.saleBadgeSyncItem.findMany(
        {
          where: {
            jobId:
            job.id,
          },

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

          skip,

          take:
          RESULT_PAGE_SIZE,
        },
      ),

      db.saleBadgeSyncItem.findMany(
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
    ]);

  const totalPages =
    job.changes > 0
      ? Math.ceil(
        job.changes /
        RESULT_PAGE_SIZE,
      )
      : 0;

  return {
    job,
    items,

    affectedProducts:
    affectedProductsRows.length,

    page,
    totalPages,
  };
}

/*
|--------------------------------------------------------------------------
| Action
|--------------------------------------------------------------------------
*/

export async function action({
                               request,
                             }) {
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
  | Start Dry Run
  |--------------------------------------------------------------------------
  */

  if (
    intent ===
    "start-dry-run"
  ) {
    await db.saleBadgeSyncJob.updateMany(
      {
        where: {
          shop:
          session.shop,

          status: {
            in: [
              "PENDING",
              "RUNNING",
            ],
          },
        },

        data: {
          status:
            "CANCELLED",
        },
      },
    );

    const job =
      await db.saleBadgeSyncJob.create(
        {
          data: {
            shop:
            session.shop,

            status:
              "RUNNING",

            checked:
              0,

            changes:
              0,

            addCount:
              0,

            removeCount:
              0,

            errors:
              0,

            cursor:
              null,
          },
        },
      );

    return {
      success: true,
      type: "dry-run",
      jobId: job.id,
      completed:
        false,
      message:
        "Full catalog dry run started.",
    };
  }

  /*
  |--------------------------------------------------------------------------
  | Scan next Shopify page
  |--------------------------------------------------------------------------
  */

  if (
    intent ===
    "scan-next-page"
  ) {
    const jobId =
      formData.get(
        "jobId",
      );

    const job =
      await db.saleBadgeSyncJob.findFirst(
        {
          where: {
            id: jobId,
            shop:
            session.shop,
          },
        },
      );

    if (!job) {
      return {
        success: false,
        message:
          "Dry run job not found.",
      };
    }

    if (
      job.status ===
      "COMPLETED"
    ) {
      return {
        success: true,
        type: "dry-run",
        jobId:
        job.id,
        completed:
          true,
        message:
          "Full catalog dry run already completed.",
      };
    }

    try {
      const response =
        await admin.graphql(
          `#graphql
            query SaleBadgeFullDryRun(
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
              SHOPIFY_PAGE_SIZE,

              after:
                job.cursor ||
                null,
            },
          },
        );

      const json =
        await response.json();

      if (
        json.errors
      ) {
        console.error(
          json.errors,
        );

        await db.saleBadgeSyncJob.update(
          {
            where: {
              id: job.id,
            },

            data: {
              status:
                "FAILED",

              errors: {
                increment:
                  1,
              },
            },
          },
        );

        return {
          success:
            false,

          message:
            "Shopify GraphQL returned an error.",
        };
      }

      const connection =
        json.data
          .productVariants;

      const variants =
        connection.nodes;

      let addCount = 0;
      let removeCount = 0;

      const problemItems =
        [];

      for (
        const variant
        of variants
        ) {
        const state =
          getVariantState(
            variant,
          );

        if (
          state.action ===
          "NONE"
        ) {
          continue;
        }

        if (
          state.action ===
          "ADD_SALE"
        ) {
          addCount += 1;
        }

        if (
          state.action ===
          "REMOVE_SALE"
        ) {
          removeCount += 1;
        }

        problemItems.push(
          {
            jobId:
            job.id,

            variantId:
            variant.id,

            productId:
            variant.product
              .id,

            productTitle:
            variant.product
              .title,

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
              null &&
              variant.compareAtPrice !==
              undefined
                ? String(
                  variant.compareAtPrice,
                )
                : null,

            action:
            state.action,

            isOnSale:
            state.isOnSale,

            hasSaleBadge:
            state.hasSaleBadge,
          },
        );
      }

      if (
        problemItems.length >
        0
      ) {
        await db.saleBadgeSyncItem.createMany(
          {
            data:
            problemItems,

            skipDuplicates:
              true,
          },
        );
      }

      const hasNextPage =
        connection.pageInfo
          .hasNextPage;

      const updatedJob =
        await db.saleBadgeSyncJob.update(
          {
            where: {
              id: job.id,
            },

            data: {
              checked: {
                increment:
                variants.length,
              },

              changes: {
                increment:
                problemItems.length,
              },

              addCount: {
                increment:
                addCount,
              },

              removeCount:
                {
                  increment:
                  removeCount,
                },

              cursor:
              connection
                .pageInfo
                .endCursor,

              status:
                hasNextPage
                  ? "RUNNING"
                  : "COMPLETED",
            },
          },
        );

      return {
        success: true,

        type:
          "dry-run",

        jobId:
        updatedJob.id,

        completed:
          !hasNextPage,

        checked:
        updatedJob.checked,

        changes:
        updatedJob.changes,

        addCount:
        updatedJob.addCount,

        removeCount:
        updatedJob.removeCount,

        message:
          hasNextPage
            ? `Checked ${updatedJob.checked} variants...`
            : "Full catalog dry run completed.",
      };
    } catch (
      error
      ) {
      console.error(
        "Dry run error:",
        error,
      );

      await db.saleBadgeSyncJob.update(
        {
          where: {
            id: job.id,
          },

          data: {
            status:
              "FAILED",

            errors: {
              increment:
                1,
            },
          },
        },
      );

      return {
        success:
          false,

        message:
          error instanceof
          Error
            ? error.message
            : "Unknown dry run error.",
      };
    }
  }

  /*
  |--------------------------------------------------------------------------
  | Apply next batch
  |--------------------------------------------------------------------------
  */

  if (
    intent ===
    "apply-next-batch"
  ) {
    const jobId =
      formData.get(
        "jobId",
      );

    const offset =
      Math.max(
        Number(
          formData.get(
            "offset",
          ) || 0,
        ),
        0,
      );

    const job =
      await db.saleBadgeSyncJob.findFirst(
        {
          where: {
            id: jobId,

            shop:
            session.shop,

            status:
              "COMPLETED",
          },
        },
      );

    if (!job) {
      return {
        success:
          false,

        message:
          "A completed dry run is required before applying changes.",
      };
    }

    if (
      job.changes <=
      0
    ) {
      return {
        success:
          false,

        message:
          "There are no SALE badge changes to apply.",
      };
    }

    const items =
      await db.saleBadgeSyncItem.findMany(
        {
          where: {
            jobId:
            job.id,
          },

          orderBy: {
            createdAt:
              "asc",
          },

          skip:
          offset,

          take:
          APPLY_BATCH_SIZE,
        },
      );

    if (
      items.length ===
      0
    ) {
      return {
        success: true,

        type:
          "apply",

        completed:
          true,

        nextOffset:
        offset,

        processed:
        offset,

        total:
        job.changes,

        updated:
          0,

        added:
          0,

        removed:
          0,

        skipped:
          0,

        failed:
          0,

        message:
          "All SALE badge changes have been processed.",
      };
    }

    let updated = 0;
    let added = 0;
    let removed = 0;
    let skipped = 0;
    let failed = 0;

    /*
    |--------------------------------------------------------------------------
    | Process each variant
    |--------------------------------------------------------------------------
    */

    for (
      const item
      of items
      ) {
      try {
        /*
        |--------------------------------------------------------------------------
        | Re-read current variant state
        |--------------------------------------------------------------------------
        */

        const response =
          await admin.graphql(
            `#graphql
              query CurrentVariantState(
                $id: ID!
              ) {
                productVariant(
                  id: $id
                ) {
                  id
                  price
                  compareAtPrice

                  metafield(
                    namespace: "${BADGE_NAMESPACE}"
                    key: "${BADGE_KEY}"
                  ) {
                    id
                    type
                    value
                  }
                }
              }
            `,

            {
              variables: {
                id:
                item.variantId,
              },
            },
          );

        const json =
          await response.json();

        if (
          json.errors
        ) {
          console.error(
            json.errors,
          );

          failed += 1;
          continue;
        }

        const variant =
          json.data
            .productVariant;

        if (
          !variant
        ) {
          skipped += 1;
          continue;
        }

        const state =
          getVariantState(
            variant,
          );

        /*
        |--------------------------------------------------------------------------
        | Already correct
        |--------------------------------------------------------------------------
        */

        if (
          state.action ===
          "NONE"
        ) {
          skipped += 1;
          continue;
        }

        let nextBadges = [
          ...state.badges,
        ];

        /*
        |--------------------------------------------------------------------------
        | ADD SALE
        |--------------------------------------------------------------------------
        */

        if (
          state.action ===
          "ADD_SALE"
        ) {
          if (
            !nextBadges.includes(
              SALE_BADGE_GID,
            )
          ) {
            nextBadges.push(
              SALE_BADGE_GID,
            );
          }
        }

        /*
        |--------------------------------------------------------------------------
        | REMOVE SALE
        |--------------------------------------------------------------------------
        */

        if (
          state.action ===
          "REMOVE_SALE"
        ) {
          nextBadges =
            nextBadges.filter(
              (badge) =>
                badge !==
                SALE_BADGE_GID,
            );
        }

        /*
        |--------------------------------------------------------------------------
        | Update metafield
        |--------------------------------------------------------------------------
        */

        const mutationResponse =
          await admin.graphql(
            `#graphql
              mutation UpdateSaleBadge(
                $metafields: [MetafieldsSetInput!]!
              ) {
                metafieldsSet(
                  metafields: $metafields
                ) {
                  metafields {
                    id
                    namespace
                    key
                    value
                  }

                  userErrors {
                    field
                    message
                    code
                  }
                }
              }
            `,

            {
              variables: {
                metafields: [
                  {
                    ownerId:
                    item.variantId,

                    namespace:
                    BADGE_NAMESPACE,

                    key:
                    BADGE_KEY,

                    type:
                      "list.metaobject_reference",

                    value:
                      JSON.stringify(
                        nextBadges,
                      ),
                  },
                ],
              },
            },
          );

        const mutationJson =
          await mutationResponse.json();

        if (
          mutationJson.errors
        ) {
          console.error(
            mutationJson.errors,
          );

          failed += 1;
          continue;
        }

        const userErrors =
          mutationJson.data
            ?.metafieldsSet
            ?.userErrors ||
          [];

        if (
          userErrors.length >
          0
        ) {
          console.error(
            "metafieldsSet userErrors:",
            userErrors,
          );

          failed += 1;
          continue;
        }

        updated += 1;

        if (
          state.action ===
          "ADD_SALE"
        ) {
          added += 1;
        }

        if (
          state.action ===
          "REMOVE_SALE"
        ) {
          removed += 1;
        }
      } catch (
        error
        ) {
        console.error(
          `Failed to update ${item.variantId}:`,
          error,
        );

        failed += 1;
      }
    }

    const nextOffset =
      offset +
      items.length;

    const completed =
      nextOffset >=
      job.changes;

    return {
      success: true,

      type:
        "apply",

      completed,

      nextOffset,

      processed:
      nextOffset,

      total:
      job.changes,

      updated,

      added,

      removed,

      skipped,

      failed,

      message:
        completed
          ? "All SALE badge changes have been processed."
          : `Processed ${nextOffset} of ${job.changes} variants.`,
    };
  }

  return {
    success: false,
    message:
      "Unknown action.",
  };
}

/*
|--------------------------------------------------------------------------
| Page
|--------------------------------------------------------------------------
*/

export default function SaleSyncPage() {
  const {
    job,
    items,
    affectedProducts,
    page,
    totalPages,
  } =
    useLoaderData();

  const dryRunFetcher =
    useFetcher();

  const applyFetcher =
    useFetcher();

  const navigate =
    useNavigate();

  const [searchParams] =
    useSearchParams();

  /*
  |--------------------------------------------------------------------------
  | Dry run state
  |--------------------------------------------------------------------------
  */

  const [
    autoScanning,
    setAutoScanning,
  ] =
    useState(
      job?.status ===
      "RUNNING",
    );

  const [
    currentJobId,
    setCurrentJobId,
  ] =
    useState(
      job?.id ||
      null,
    );

  /*
  |--------------------------------------------------------------------------
  | Apply state
  |--------------------------------------------------------------------------
  */

  const [
    autoApplying,
    setAutoApplying,
  ] =
    useState(false);

  const [
    applyProgress,
    setApplyProgress,
  ] =
    useState(null);

  /*
  |--------------------------------------------------------------------------
  | Can apply?
  |--------------------------------------------------------------------------
  |
  | IMPORTANT:
  | Update all products is active ONLY when:
  |
  | 1. Dry run exists
  | 2. Dry run status = COMPLETED
  | 3. There are variants to change
  |
  */

  const canApply =
    job?.status ===
    "COMPLETED" &&
    job?.changes > 0;

  /*
  |--------------------------------------------------------------------------
  | Start Dry Run
  |--------------------------------------------------------------------------
  */

  function startDryRun() {
    if (
      dryRunFetcher.state !==
      "idle"
    ) {
      return;
    }

    /*
     * Reset any previous apply progress.
     */

    setAutoApplying(
      false,
    );

    setApplyProgress(
      null,
    );

    const formData =
      new FormData();

    formData.set(
      "intent",
      "start-dry-run",
    );

    dryRunFetcher.submit(
      formData,
      {
        method:
          "post",
      },
    );
  }

  /*
  |--------------------------------------------------------------------------
  | Continue Dry Run
  |--------------------------------------------------------------------------
  */

  function scanNextPage(
    jobId,
  ) {
    if (
      !jobId ||
      dryRunFetcher.state !==
      "idle"
    ) {
      return;
    }

    const formData =
      new FormData();

    formData.set(
      "intent",
      "scan-next-page",
    );

    formData.set(
      "jobId",
      jobId,
    );

    dryRunFetcher.submit(
      formData,
      {
        method:
          "post",
      },
    );
  }

  /*
  |--------------------------------------------------------------------------
  | Handle Dry Run responses
  |--------------------------------------------------------------------------
  */

  useEffect(() => {
    const data =
      dryRunFetcher.data;

    if (
      !data
    ) {
      return;
    }

    if (
      data.success ===
      false
    ) {
      setAutoScanning(
        false,
      );

      return;
    }

    if (
      data.type !==
      "dry-run"
    ) {
      return;
    }

    if (
      data.jobId
    ) {
      setCurrentJobId(
        data.jobId,
      );
    }

    if (
      data.completed
    ) {
      setAutoScanning(
        false,
      );

      /*
       * Reload loader data so that the completed
       * job and its result list are displayed.
       */

      navigate(
        "/app/sale-sync",
        {
          replace:
            true,
        },
      );

      return;
    }

    setAutoScanning(
      true,
    );
  }, [
    dryRunFetcher.data,
    navigate,
  ]);

  /*
  |--------------------------------------------------------------------------
  | Automatic Dry Run pagination
  |--------------------------------------------------------------------------
  */

  useEffect(() => {
    if (
      !autoScanning
    ) {
      return;
    }

    if (
      !currentJobId
    ) {
      return;
    }

    if (
      dryRunFetcher.state !==
      "idle"
    ) {
      return;
    }

    const timer =
      setTimeout(
        () => {
          scanNextPage(
            currentJobId,
          );
        },
        150,
      );

    return () =>
      clearTimeout(
        timer,
      );
  }, [
    autoScanning,
    currentJobId,
    dryRunFetcher.state,
    dryRunFetcher.data,
  ]);

  /*
  |--------------------------------------------------------------------------
  | Start Apply
  |--------------------------------------------------------------------------
  */

  function startApply() {
    /*
     * Extra client-side safety check.
     */

    if (
      !canApply
    ) {
      return;
    }

    if (
      applyFetcher.state !==
      "idle"
    ) {
      return;
    }

    setApplyProgress(
      {
        processed:
          0,

        total:
        job.changes,

        updated:
          0,

        added:
          0,

        removed:
          0,

        skipped:
          0,

        failed:
          0,

        completed:
          false,

        halted:
          false,

        nextOffset:
          0,
      },
    );

    setAutoApplying(
      true,
    );
  }

  /*
  |--------------------------------------------------------------------------
  | Submit next apply batch
  |--------------------------------------------------------------------------
  */

  function applyNextBatch(
    offset,
  ) {
    if (
      !job?.id
    ) {
      return;
    }

    if (
      applyFetcher.state !==
      "idle"
    ) {
      return;
    }

    const formData =
      new FormData();

    formData.set(
      "intent",
      "apply-next-batch",
    );

    formData.set(
      "jobId",
      job.id,
    );

    formData.set(
      "offset",
      String(offset),
    );

    applyFetcher.submit(
      formData,
      {
        method:
          "post",
      },
    );
  }

  /*
  |--------------------------------------------------------------------------
  | Automatic apply batches
  |--------------------------------------------------------------------------
  */

  useEffect(() => {
    if (
      !autoApplying
    ) {
      return;
    }

    if (
      !applyProgress
    ) {
      return;
    }

    if (
      applyProgress.completed
    ) {
      return;
    }

    if (
      applyFetcher.state !==
      "idle"
    ) {
      return;
    }

    const timer =
      setTimeout(
        () => {
          applyNextBatch(
            applyProgress.nextOffset ||
            0,
          );
        },
        200,
      );

    return () =>
      clearTimeout(
        timer,
      );
  }, [
    autoApplying,
    applyProgress,
    applyFetcher.state,
  ]);

  /*
  |--------------------------------------------------------------------------
  | Handle Apply response
  |--------------------------------------------------------------------------
  */

  useEffect(() => {
    const data =
      applyFetcher.data;

    if (
      !data ||
      data.type !==
      "apply"
    ) {
      return;
    }

    if (
      data.success ===
      false
    ) {
      setAutoApplying(
        false,
      );

      setApplyProgress(
        (previous) => ({
          ...(previous ||
            {}),

          halted:
            true,
        }),
      );

      return;
    }

    setApplyProgress(
      (previous) => {
        const prev =
          previous || {
            processed:
              0,

            total:
              data.total ||
              0,

            updated:
              0,

            added:
              0,

            removed:
              0,

            skipped:
              0,

            failed:
              0,
          };

        return {
          processed:
          data.processed,

          total:
          data.total,

          updated:
            prev.updated +
            (data.updated ||
              0),

          added:
            prev.added +
            (data.added ||
              0),

          removed:
            prev.removed +
            (data.removed ||
              0),

          skipped:
            prev.skipped +
            (data.skipped ||
              0),

          failed:
            prev.failed +
            (data.failed ||
              0),

          nextOffset:
          data.nextOffset,

          completed:
            Boolean(
              data.completed,
            ),

          halted:
            false,
        };
      },
    );

    if (
      data.completed
    ) {
      setAutoApplying(
        false,
      );
    }
  }, [
    applyFetcher.data,
  ]);

  /*
  |--------------------------------------------------------------------------
  | Resume apply
  |--------------------------------------------------------------------------
  */

  function resumeApply() {
    if (
      !applyProgress ||
      applyProgress.completed
    ) {
      return;
    }

    setApplyProgress(
      (previous) => ({
        ...previous,
        halted:
          false,
      }),
    );

    setAutoApplying(
      true,
    );
  }

  /*
  |--------------------------------------------------------------------------
  | Status helpers
  |--------------------------------------------------------------------------
  */

  const isDryRunBusy =
    dryRunFetcher.state !==
    "idle" ||
    autoScanning;

  const isApplyBusy =
    applyFetcher.state !==
    "idle" ||
    autoApplying;

  const dryRunMessage =
    dryRunFetcher.data
      ?.message;

  const applyMessage =
    applyFetcher.data
      ?.message;

  const currentChecked =
    dryRunFetcher.data
      ?.checked ??
    job?.checked ??
    0;

  const currentChanges =
    dryRunFetcher.data
      ?.changes ??
    job?.changes ??
    0;

  const currentAdd =
    dryRunFetcher.data
      ?.addCount ??
    job?.addCount ??
    0;

  const currentRemove =
    dryRunFetcher.data
      ?.removeCount ??
    job?.removeCount ??
    0;

  const currentStatus =
    isDryRunBusy
      ? "RUNNING"
      : job?.status ||
      "NOT STARTED";

  /*
  |--------------------------------------------------------------------------
  | Pagination URLs
  |--------------------------------------------------------------------------
  */

  const previousUrl =
    useMemo(() => {
      const params =
        new URLSearchParams(
          searchParams,
        );

      params.set(
        "page",
        String(
          Math.max(
            page - 1,
            1,
          ),
        ),
      );

      return `/app/sale-sync?${params.toString()}`;
    }, [
      page,
      searchParams,
    ]);

  const nextUrl =
    useMemo(() => {
      const params =
        new URLSearchParams(
          searchParams,
        );

      params.set(
        "page",
        String(
          page + 1,
        ),
      );

      return `/app/sale-sync?${params.toString()}`;
    }, [
      page,
      searchParams,
    ]);

  /*
  |--------------------------------------------------------------------------
  | Render
  |--------------------------------------------------------------------------
  */

  return (
    <s-page heading="SALE badge sync">
      {/*
      |--------------------------------------------------------------------------
      | DRY RUN
      |--------------------------------------------------------------------------
      */}

      <s-section heading="Full catalog dry run">
        <s-paragraph>
          This scan does not change Shopify data.
          It checks the full variant catalog in
          pages of {SHOPIFY_PAGE_SIZE} and stores
          only variants that require a SALE badge
          change.
        </s-paragraph>

        <div
          style={{
            marginTop:
              "18px",
          }}
        >
          <button
            type="button"
            disabled={
              isDryRunBusy ||
              isApplyBusy
            }
            onClick={
              startDryRun
            }
            style={{
              ...primaryButtonStyle,

              opacity:
                isDryRunBusy ||
                isApplyBusy
                  ? 0.5
                  : 1,

              cursor:
                isDryRunBusy ||
                isApplyBusy
                  ? "not-allowed"
                  : "pointer",
            }}
          >
            {isDryRunBusy
              ? "Scanning catalog..."
              : "Start full dry run"}
          </button>
        </div>

        <div
          style={
            statsGridStyle
          }
        >
          <StatCard
            label="Status"
            value={
              currentStatus
            }
          />

          <StatCard
            label="Variants checked"
            value={
              currentChecked
            }
          />

          <StatCard
            label="Products affected"
            value={
              job?.status ===
              "COMPLETED"
                ? affectedProducts
                : "-"
            }
          />

          <StatCard
            label="Variants to change"
            value={
              currentChanges
            }
          />

          <StatCard
            label="ADD SALE"
            value={
              currentAdd
            }
          />

          <StatCard
            label="REMOVE SALE"
            value={
              currentRemove
            }
          />

          <StatCard
            label="Errors"
            value={
              job?.errors ??
              0
            }
          />
        </div>

        {dryRunMessage && (
          <div
            style={
              dryRunFetcher.data
                ?.success ===
              false
                ? errorBoxStyle
                : infoBoxStyle
            }
          >
            {dryRunMessage}
          </div>
        )}

        {isDryRunBusy && (
          <div
            style={{
              marginTop:
                "16px",
            }}
          >
            <ProgressBar
              current={
                currentChecked
              }
              indeterminate
            />
          </div>
        )}
      </s-section>

      {/*
      |--------------------------------------------------------------------------
      | RESULT LIST
      |--------------------------------------------------------------------------
      */}

      {job?.status ===
        "COMPLETED" && (
          <s-section heading="Variants requiring changes">
            <s-paragraph>
              Dry run found{" "}
              <strong>
                {job.changes}
              </strong>{" "}
              variants across{" "}
              <strong>
                {
                  affectedProducts
                }
              </strong>{" "}
              products that require
              a SALE badge update.
            </s-paragraph>

            {items.length ===
            0 ? (
              <div
                style={{
                  marginTop:
                    "18px",

                  padding:
                    "18px",

                  border:
                    "1px solid #ddd",

                  borderRadius:
                    "8px",
                }}
              >
                No incorrect SALE
                badge states were
                found.
              </div>
            ) : (
              <>
                <div
                  style={{
                    overflowX:
                      "auto",

                    marginTop:
                      "18px",
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
                        Variant ID
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
                        Product
                      </th>
                    </tr>
                    </thead>

                    <tbody>
                    {items.map(
                      (
                        item,
                      ) => (
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
                            {getNumericId(
                              item.variantId,
                            )}
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
                              href={`shopify://admin/products/${getNumericId(
                                item.productId,
                              )}`}
                              target="_top"
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

                {totalPages >
                  1 && (
                    <div
                      style={
                        paginationStyle
                      }
                    >
                      {page >
                      1 ? (
                        <a
                          href={
                            previousUrl
                          }
                        >
                          Previous
                        </a>
                      ) : (
                        <span
                          style={{
                            opacity:
                              0.45,
                          }}
                        >
                      Previous
                    </span>
                      )}

                      <strong>
                        Page {page} of{" "}
                        {
                          totalPages
                        }
                      </strong>

                      {page <
                      totalPages ? (
                        <a
                          href={
                            nextUrl
                          }
                        >
                          Next
                        </a>
                      ) : (
                        <span
                          style={{
                            opacity:
                              0.45,
                          }}
                        >
                      Next
                    </span>
                      )}
                    </div>
                  )}
              </>
            )}

            {/*
          |--------------------------------------------------------------------------
          | APPLY ALL BLOCK
          |--------------------------------------------------------------------------
          */}

            <div
              style={
                applyBlockStyle
              }
            >
              <h2
                style={{
                  margin:
                    "0 0 8px",
                }}
              >
                Apply SALE badge
                changes
              </h2>

              <p
                style={{
                  margin:
                    "0 0 18px",

                  lineHeight:
                    1.5,
                }}
              >
                {job?.status ===
                "COMPLETED" ? (
                  <>
                    The completed
                    dry run found{" "}
                    <strong>
                      {
                        job.changes
                      }
                    </strong>{" "}
                    variants across{" "}
                    <strong>
                      {
                        affectedProducts
                      }
                    </strong>{" "}
                    products that
                    require an
                    update.
                  </>
                ) : (
                  <>
                    Run and
                    complete the
                    full catalog
                    dry run before
                    applying SALE
                    badge changes.
                  </>
                )}
              </p>

              <div
                style={{
                  display:
                    "grid",

                  gridTemplateColumns:
                    "repeat(auto-fit, minmax(150px, 1fr))",

                  gap:
                    "12px",

                  marginBottom:
                    "20px",
                }}
              >
                <StatCard
                  label="Products"
                  value={
                    job?.status ===
                    "COMPLETED"
                      ? affectedProducts
                      : "-"
                  }
                />

                <StatCard
                  label="Variants"
                  value={
                    job?.status ===
                    "COMPLETED"
                      ? job.changes
                      : "-"
                  }
                />

                <StatCard
                  label="ADD SALE"
                  value={
                    job?.status ===
                    "COMPLETED"
                      ? job.addCount
                      : "-"
                  }
                />

                <StatCard
                  label="REMOVE SALE"
                  value={
                    job?.status ===
                    "COMPLETED"
                      ? job.removeCount
                      : "-"
                  }
                />
              </div>

              <div
                style={{
                  marginBottom:
                    "18px",

                  padding:
                    "12px 14px",

                  background:
                    "#f6f6f7",

                  border:
                    "1px solid #ddd",

                  borderRadius:
                    "8px",

                  lineHeight:
                    1.5,
                }}
              >
                Each variant is
                re-read from Shopify
                immediately before
                the update. If its
                price or SALE badge
                state has changed
                since the dry run,
                the current state is
                used.
              </div>

              {applyProgress && (
                <div
                  style={{
                    marginBottom:
                      "20px",
                  }}
                >
                  <div
                    style={{
                      display:
                        "grid",

                      gridTemplateColumns:
                        "repeat(auto-fit, minmax(140px, 1fr))",

                      gap:
                        "10px",

                      marginBottom:
                        "14px",
                    }}
                  >
                    <StatCard
                      label="Processed"
                      value={`${applyProgress.processed} / ${applyProgress.total}`}
                    />

                    <StatCard
                      label="Updated"
                      value={
                        applyProgress.updated
                      }
                    />

                    <StatCard
                      label="Added SALE"
                      value={
                        applyProgress.added
                      }
                    />

                    <StatCard
                      label="Removed SALE"
                      value={
                        applyProgress.removed
                      }
                    />

                    <StatCard
                      label="Skipped"
                      value={
                        applyProgress.skipped
                      }
                    />

                    <StatCard
                      label="Failed"
                      value={
                        applyProgress.failed
                      }
                    />
                  </div>

                  <ProgressBar
                    current={
                      applyProgress.processed
                    }
                    total={
                      applyProgress.total
                    }
                  />
                </div>
              )}

              {applyMessage && (
                <div
                  style={
                    applyFetcher
                      .data
                      ?.success
                      ? successBoxStyle
                      : errorBoxStyle
                  }
                >
                  {
                    applyMessage
                  }
                </div>
              )}

              {!applyProgress && (
                <button
                  type="button"
                  disabled={
                    !canApply ||
                    isApplyBusy
                  }
                  onClick={
                    startApply
                  }
                  style={{
                    ...dangerButtonStyle,

                    opacity:
                      !canApply ||
                      isApplyBusy
                        ? 0.5
                        : 1,

                    cursor:
                      !canApply ||
                      isApplyBusy
                        ? "not-allowed"
                        : "pointer",
                  }}
                >
                  {job?.status !==
                  "COMPLETED"
                    ? "Complete dry run first"
                    : job.changes ===
                    0
                      ? "No products to update"
                      : "Update all products"}
                </button>
              )}

              {autoApplying && (
                <div
                  style={{
                    display:
                      "flex",

                    alignItems:
                      "center",

                    gap:
                      "12px",

                    flexWrap:
                      "wrap",
                  }}
                >
                  <button
                    type="button"
                    onClick={() => {
                      setAutoApplying(
                        false,
                      );
                    }}
                    style={
                      secondaryButtonStyle
                    }
                  >
                    Pause updates
                  </button>

                  <strong>
                    Updating
                    products...
                  </strong>
                </div>
              )}

              {applyProgress &&
                !applyProgress.completed &&
                !autoApplying && (
                  <div
                    style={{
                      display:
                        "flex",

                      gap:
                        "12px",

                      flexWrap:
                        "wrap",
                    }}
                  >
                    <button
                      type="button"
                      disabled={
                        applyFetcher.state !==
                        "idle"
                      }
                      onClick={
                        resumeApply
                      }
                      style={
                        primaryButtonStyle
                      }
                    >
                      {applyProgress.halted
                        ? "Retry / Resume updates"
                        : "Resume updates"}
                    </button>
                  </div>
                )}

              {applyProgress
                ?.completed && (
                <div
                  style={{
                    marginTop:
                      "16px",

                    padding:
                      "16px",

                    border:
                      "1px solid #008060",

                    background:
                      "#f1f8f5",

                    borderRadius:
                      "8px",

                    lineHeight:
                      1.5,
                  }}
                >
                  <strong>
                    Update
                    completed.
                  </strong>

                  <div
                    style={{
                      marginTop:
                        "6px",
                    }}
                  >
                    Run a new Full
                    catalog dry run
                    to verify the
                    current state of
                    the entire
                    store.
                  </div>
                </div>
              )}
            </div>
          </s-section>
        )}

      {/*
      |--------------------------------------------------------------------------
      | Apply block before first Dry Run
      |--------------------------------------------------------------------------
      */}

      {job?.status !==
        "COMPLETED" && (
          <s-section heading="Apply SALE badge changes">
            <s-paragraph>
              Complete a full
              catalog dry run
              before applying any
              SALE badge changes.
            </s-paragraph>

            <div
              style={{
                marginTop:
                  "18px",
              }}
            >
              <button
                type="button"
                disabled
                style={{
                  ...dangerButtonStyle,

                  opacity:
                    0.5,

                  cursor:
                    "not-allowed",
                }}
              >
                Complete dry run
                first
              </button>
            </div>
          </s-section>
        )}
    </s-page>
  );
}

/*
|--------------------------------------------------------------------------
| Components
|--------------------------------------------------------------------------
*/

function StatCard({
                    label,
                    value,
                  }) {
  return (
    <div
      style={{
        border:
          "1px solid #ddd",

        borderRadius:
          "10px",

        padding:
          "14px 16px",

        background:
          "#fff",
      }}
    >
      <div
        style={{
          fontSize:
            "13px",

          color:
            "#616161",

          marginBottom:
            "6px",
        }}
      >
        {label}
      </div>

      <div
        style={{
          fontSize:
            "24px",

          fontWeight:
            700,
        }}
      >
        {value}
      </div>
    </div>
  );
}

function ProgressBar({
                       current = 0,
                       total = 0,
                       indeterminate = false,
                     }) {
  let percentage = 0;

  if (
    !indeterminate &&
    total > 0
  ) {
    percentage =
      Math.min(
        100,
        Math.round(
          (current /
            total) *
          100,
        ),
      );
  }

  return (
    <div>
      {!indeterminate && (
        <div
          style={{
            marginBottom:
              "6px",

            fontSize:
              "13px",
          }}
        >
          {percentage}%
        </div>
      )}

      <div
        style={{
          width:
            "100%",

          height:
            "10px",

          background:
            "#e1e3e5",

          borderRadius:
            "999px",

          overflow:
            "hidden",
        }}
      >
        <div
          style={{
            width:
              indeterminate
                ? "35%"
                : `${percentage}%`,

            height:
              "100%",

            background:
              "#303030",

            borderRadius:
              "999px",

            transition:
              "width 0.2s ease",
          }}
        />
      </div>
    </div>
  );
}

/*
|--------------------------------------------------------------------------
| Utility
|--------------------------------------------------------------------------
*/

function getNumericId(
  gid,
) {
  if (!gid) {
    return "";
  }

  return gid
    .split("/")
    .pop();
}

/*
|--------------------------------------------------------------------------
| Styles
|--------------------------------------------------------------------------
*/

const cellStyle = {
  padding:
    "10px",

  borderBottom:
    "1px solid #ddd",

  textAlign:
    "left",

  whiteSpace:
    "nowrap",

  verticalAlign:
    "middle",
};

const statsGridStyle = {
  display:
    "grid",

  gridTemplateColumns:
    "repeat(auto-fit, minmax(160px, 1fr))",

  gap:
    "12px",

  marginTop:
    "20px",

  marginBottom:
    "20px",
};

const paginationStyle = {
  display:
    "flex",

  alignItems:
    "center",

  gap:
    "14px",

  marginTop:
    "18px",

  flexWrap:
    "wrap",
};

const applyBlockStyle = {
  marginTop:
    "28px",

  padding:
    "20px",

  border:
    "1px solid #d9d9d9",

  borderRadius:
    "10px",

  background:
    "#fff",
};

const primaryButtonStyle = {
  padding:
    "10px 18px",

  border:
    "1px solid #303030",

  borderRadius:
    "6px",

  background:
    "#303030",

  color:
    "#fff",

  fontWeight:
    600,

  cursor:
    "pointer",
};

const secondaryButtonStyle = {
  padding:
    "10px 18px",

  border:
    "1px solid #8c9196",

  borderRadius:
    "6px",

  background:
    "#fff",

  color:
    "#202223",

  fontWeight:
    600,

  cursor:
    "pointer",
};

const dangerButtonStyle = {
  padding:
    "11px 20px",

  border:
    "1px solid #8e1f0b",

  borderRadius:
    "6px",

  background:
    "#b42318",

  color:
    "#fff",

  fontWeight:
    700,

  cursor:
    "pointer",
};

const infoBoxStyle = {
  marginTop:
    "16px",

  padding:
    "14px 16px",

  border:
    "1px solid #c9cccf",

  borderRadius:
    "8px",

  background:
    "#f6f6f7",
};

const successBoxStyle = {
  marginBottom:
    "16px",

  padding:
    "14px 16px",

  border:
    "1px solid #008060",

  borderRadius:
    "8px",

  background:
    "#f1f8f5",
};

const errorBoxStyle = {
  marginTop:
    "16px",

  marginBottom:
    "16px",

  padding:
    "14px 16px",

  border:
    "1px solid #d72c0d",

  borderRadius:
    "8px",

  background:
    "#fff4f4",
};
