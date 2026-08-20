import { useEffect, useMemo, useState } from "react";
import {
  Link,
  useFetcher,
  useLoaderData,
  useNavigate,
  useSearchParams,
} from "react-router";

import prisma from "../db.server";
import { authenticate } from "../shopify.server";

/*
|--------------------------------------------------------------------------
| Configuration
|--------------------------------------------------------------------------
*/

const SALE_BADGE_GID =
  "gid://shopify/Metaobject/92904096052";

const BADGE_NAMESPACE = "custom";
const BADGE_KEY = "product_badges";
const BADGE_TYPE = "list.metaobject_reference";

const SHOPIFY_PAGE_SIZE = 250;
const RESULT_PAGE_SIZE = 50;

/*
 * Shopify metafieldsSet accepts a maximum of 25 inputs.
 */
const APPLY_BATCH_SIZE = 25;

const DRY_RUN_DELAY_MS = 200;
const APPLY_DELAY_MS = 400;

const VALID_FILTERS = new Set([
  "ALL",
  "ADD_SALE",
  "REMOVE_SALE",
]);

/*
|--------------------------------------------------------------------------
| Helpers
|--------------------------------------------------------------------------
*/

function parseBadges(value) {
  if (!value) {
    return {
      valid: true,
      badges: [],
    };
  }

  try {
    const parsed = JSON.parse(value);

    if (!Array.isArray(parsed)) {
      return {
        valid: false,
        badges: [],
      };
    }

    if (
      parsed.some(
        (item) =>
          typeof item !== "string",
      )
    ) {
      return {
        valid: false,
        badges: [],
      };
    }

    return {
      valid: true,
      badges: [
        ...new Set(parsed),
      ],
    };
  } catch {
    return {
      valid: false,
      badges: [],
    };
  }
}

function analyseVariant(variant) {
  const parsed =
    parseBadges(
      variant.metafield?.value,
    );

  if (!parsed.valid) {
    return {
      valid: false,
      badges: [],
      isOnSale: false,
      hasSaleBadge: false,
      discountPercent: 0,
      action: "ERROR",
    };
  }

  const price =
    Number(
      variant.price,
    );

  const compareAtPrice =
    variant.compareAtPrice !== null &&
    variant.compareAtPrice !== undefined
      ? Number(
        variant.compareAtPrice,
      )
      : null;

  if (
    !Number.isFinite(price) ||
    (
      compareAtPrice !== null &&
      !Number.isFinite(
        compareAtPrice,
      )
    )
  ) {
    return {
      valid: false,
      badges: parsed.badges,
      isOnSale: false,
      hasSaleBadge:
        parsed.badges.includes(
          SALE_BADGE_GID,
        ),
      discountPercent: 0,
      action: "ERROR",
    };
  }

  let discountPercent = 0;

  if (
    compareAtPrice !== null &&
    compareAtPrice > 0 &&
    compareAtPrice > price
  ) {
    discountPercent =
      (
        (
          compareAtPrice -
          price
        ) /
        compareAtPrice
      ) *
      100;
  }

  /*
   * SALE only when discount
   * is at least 1%.
   */
  const isOnSale =
    discountPercent >= 1;

  const hasSaleBadge =
    parsed.badges.includes(
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
    valid: true,
    badges: parsed.badges,
    price,
    compareAtPrice,

    discountPercent:
      Number(
        discountPercent.toFixed(2),
      ),

    isOnSale,
    hasSaleBadge,
    action,
  };
}

function getNumericId(gid) {
  if (!gid) {
    return "";
  }

  return gid
    .split("/")
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

function normalizeInteger(
  value,
  fallback = 0,
) {
  const parsed =
    Number.parseInt(
      String(
        value ?? "",
      ),
      10,
    );

  if (
    !Number.isFinite(parsed) ||
    parsed < 0
  ) {
    return fallback;
  }

  return parsed;
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
    cursor: job.cursor,
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
   * IMPORTANT:
   * SaleBadgeSyncJob has startedAt,
   * NOT createdAt.
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

  if (!job) {
    return {
      job: null,
      items: [],
      affectedProducts: 0,
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
    jobId:
    job.id,

    ...(filter !== "ALL"
      ? {
        action:
        filter,
      }
      : {}),
  };

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

              {
                id:
                  "asc",
              },
            ],

            skip:
              (page - 1) *
              RESULT_PAGE_SIZE,

            take:
            RESULT_PAGE_SIZE,
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
      RESULT_PAGE_SIZE,
    );

  return {
    job:
      serializeJob(job),

    items:
      items.map(
        (item) => ({
          ...item,

          createdAt:
            item.createdAt.toISOString(),

          variantNumericId:
            getNumericId(
              item.variantId,
            ),

          productNumericId:
            getNumericId(
              item.productId,
            ),
        }),
      ),

    affectedProducts:
    distinctProducts.length,

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
  | START FULL DRY RUN
  |--------------------------------------------------------------------------
  */

  if (
    intent ===
    "startDryRun"
  ) {
    /*
     * Do not create a second running job.
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

    if (runningJob) {
      return {
        success: true,

        intent,

        message:
          "A dry run is already running. Resuming it.",

        job:
          serializeJob(
            runningJob,
          ),
      };
    }

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

            cursor:
              null,

            checked:
              0,

            changes:
              0,

            addCount:
              0,

            removeCount:
              0,

            failed:
              0,

            startedAt:
              new Date(),

            finishedAt:
              null,

            lastError:
              null,
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
  | PROCESS ONE DRY RUN PAGE
  |--------------------------------------------------------------------------
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

    const job =
      await prisma.saleBadgeSyncJob.findFirst(
        {
          where: {
            id:
            jobId,

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
          "Shopify response does not contain productVariants.",
        );
      }

      let addCount = 0;
      let removeCount = 0;
      let analysisErrors = 0;

      const problemItems =
        [];

      for (
        const variant
        of connection.nodes
        ) {
        const analysis =
          analyseVariant(
            variant,
          );

        if (
          !analysis.valid
        ) {
          analysisErrors +=
            1;

          continue;
        }

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
          removeCount +=
            1;
        }

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
              null &&
              variant.compareAtPrice !==
              undefined
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

                  failed: {
                    increment:
                    analysisErrors,
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

  /*
  |--------------------------------------------------------------------------
  | APPLY NEXT BATCH
  |--------------------------------------------------------------------------
  |
  | This action only works when the Dry Run is COMPLETED.
  |
  */

  if (
    intent ===
    "processApply"
  ) {
    const jobId =
      formData.get(
        "jobId",
      );

    const offset =
      normalizeInteger(
        formData.get(
          "offset",
        ),
      );

    const updatedSoFar =
      normalizeInteger(
        formData.get(
          "updatedSoFar",
        ),
      );

    const addedSoFar =
      normalizeInteger(
        formData.get(
          "addedSoFar",
        ),
      );

    const removedSoFar =
      normalizeInteger(
        formData.get(
          "removedSoFar",
        ),
      );

    const skippedSoFar =
      normalizeInteger(
        formData.get(
          "skippedSoFar",
        ),
      );

    const failedSoFar =
      normalizeInteger(
        formData.get(
          "failedSoFar",
        ),
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

        apply: {
          halted:
            true,
        },
      };
    }

    /*
     * Backend protection:
     * update is NOT allowed without COMPLETED Dry Run.
     */
    const job =
      await prisma.saleBadgeSyncJob.findFirst(
        {
          where: {
            id:
            jobId,

            shop:
            session.shop,

            type:
              "DRY_RUN",

            status:
              "COMPLETED",
          },
        },
      );

    if (!job) {
      return {
        success: false,
        intent,

        message:
          "A completed dry run is required before applying changes.",

        apply: {
          halted:
            true,

          nextOffset:
          offset,
        },
      };
    }

    if (
      job.changes <= 0
    ) {
      return {
        success: false,
        intent,

        message:
          "The dry run found no products to update.",

        apply: {
          halted:
            true,

          nextOffset:
          offset,
        },
      };
    }

    try {
      /*
       * Get the next 25 items from
       * the Dry Run snapshot.
       */
      const items =
        await prisma.saleBadgeSyncItem.findMany(
          {
            where: {
              jobId:
              job.id,
            },

            orderBy: [
              {
                createdAt:
                  "asc",
              },

              {
                id:
                  "asc",
              },
            ],

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
          intent,

          message:
            "All detected SALE badge changes have been processed.",

          apply: {
            completed:
              true,

            halted:
              false,

            total:
            job.changes,

            nextOffset:
            offset,

            processed:
            offset,

            updated:
            updatedSoFar,

            added:
            addedSoFar,

            removed:
            removedSoFar,

            skipped:
            skippedSoFar,

            failed:
            failedSoFar,
          },
        };
      }

      const variantIds =
        items.map(
          (item) =>
            item.variantId,
        );

      /*
       * Re-read current Shopify state.
       */
      const response =
        await admin.graphql(
          `#graphql
            query CurrentSaleBadgeVariants(
              $ids: [ID!]!
            ) {
              nodes(ids: $ids) {
                ... on ProductVariant {
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
                    compareDigest
                  }
                }
              }
            }
          `,
          {
            variables: {
              ids:
              variantIds,
            },
          },
        );

      const json =
        await response.json();

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

      const variantMap =
        new Map();

      for (
        const variant
        of json.data?.nodes ||
      []
        ) {
        if (
          variant?.id
        ) {
          variantMap.set(
            variant.id,
            variant,
          );
        }
      }

      const metafields =
        [];

      const actions =
        [];

      let batchSkipped = 0;
      let batchFailed = 0;

      for (
        const item
        of items
        ) {
        const variant =
          variantMap.get(
            item.variantId,
          );

        /*
         * Variant may have been deleted.
         */
        if (!variant) {
          batchSkipped +=
            1;

          continue;
        }

        const analysis =
          analyseVariant(
            variant,
          );

        /*
         * Never overwrite malformed data.
         */
        if (
          !analysis.valid
        ) {
          batchFailed +=
            1;

          continue;
        }

        /*
         * Already fixed by Flow,
         * external import or another user.
         */
        if (
          analysis.action ===
          "NONE"
        ) {
          batchSkipped +=
            1;

          continue;
        }

        let nextBadges = [
          ...analysis.badges,
        ];

        if (
          analysis.action ===
          "ADD_SALE"
        ) {
          nextBadges.push(
            SALE_BADGE_GID,
          );
        }

        if (
          analysis.action ===
          "REMOVE_SALE"
        ) {
          nextBadges =
            nextBadges.filter(
              (gid) =>
                gid !==
                SALE_BADGE_GID,
            );
        }

        nextBadges = [
          ...new Set(
            nextBadges,
          ),
        ];

        const input = {
          ownerId:
          variant.id,

          namespace:
          BADGE_NAMESPACE,

          key:
          BADGE_KEY,

          type:
          BADGE_TYPE,

          value:
            JSON.stringify(
              nextBadges,
            ),
        };

        /*
         * Compare-and-set protection.
         */
        if (
          variant.metafield
            ?.compareDigest
        ) {
          input.compareDigest =
            variant.metafield
              .compareDigest;
        }

        metafields.push(
          input,
        );

        actions.push(
          analysis.action,
        );
      }

      /*
       * Everything in this batch was
       * already correct/skipped.
       */
      if (
        metafields.length ===
        0
      ) {
        const nextOffset =
          offset +
          items.length;

        const completed =
          nextOffset >=
          job.changes;

        return {
          success: true,
          intent,

          message:
            completed
              ? "All detected SALE badge changes have been processed."
              : `Processed ${nextOffset} of ${job.changes} detected variants.`,

          apply: {
            completed,

            halted:
              false,

            total:
            job.changes,

            nextOffset,

            processed:
            nextOffset,

            updated:
            updatedSoFar,

            added:
            addedSoFar,

            removed:
            removedSoFar,

            skipped:
              skippedSoFar +
              batchSkipped,

            failed:
              failedSoFar +
              batchFailed,
          },
        };
      }

      /*
       * One mutation, maximum 25 metafields.
       */
      const mutationResponse =
        await admin.graphql(
          `#graphql
            mutation ApplySaleBadgeBatch(
              $metafields: [MetafieldsSetInput!]!
            ) {
              metafieldsSet(
                metafields: $metafields
              ) {
                metafields {
                  id
                  namespace
                  key
                  type
                  value
                  compareDigest
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
              metafields,
            },
          },
        );

      const mutationJson =
        await mutationResponse.json();

      if (
        mutationJson.errors
          ?.length
      ) {
        throw new Error(
          mutationJson.errors
            .map(
              (error) =>
                error.message,
            )
            .join("; "),
        );
      }

      const mutationResult =
        mutationJson.data
          ?.metafieldsSet;

      if (!mutationResult) {
        throw new Error(
          "Shopify did not return metafieldsSet result.",
        );
      }

      /*
       * metafieldsSet is atomic.
       * Do not advance the offset if Shopify
       * returns user errors.
       */
      if (
        mutationResult
          .userErrors
          ?.length
      ) {
        return {
          success: false,
          intent,

          message:
            mutationResult
              .userErrors
              .map(
                (error) =>
                  error.message,
              )
              .join("; "),

          apply: {
            completed:
              false,

            halted:
              true,

            total:
            job.changes,

            nextOffset:
            offset,

            processed:
            offset,

            updated:
            updatedSoFar,

            added:
            addedSoFar,

            removed:
            removedSoFar,

            skipped:
            skippedSoFar,

            failed:
            failedSoFar,
          },
        };
      }

      const batchUpdated =
        metafields.length;

      const batchAdded =
        actions.filter(
          (action) =>
            action ===
            "ADD_SALE",
        ).length;

      const batchRemoved =
        actions.filter(
          (action) =>
            action ===
            "REMOVE_SALE",
        ).length;

      const nextOffset =
        offset +
        items.length;

      const completed =
        nextOffset >=
        job.changes;

      return {
        success: true,
        intent,

        message:
          completed
            ? "All detected SALE badge changes have been processed."
            : `Processed ${nextOffset} of ${job.changes} detected variants.`,

        apply: {
          completed,

          halted:
            false,

          total:
          job.changes,

          nextOffset,

          processed:
          nextOffset,

          updated:
            updatedSoFar +
            batchUpdated,

          added:
            addedSoFar +
            batchAdded,

          removed:
            removedSoFar +
            batchRemoved,

          skipped:
            skippedSoFar +
            batchSkipped,

          failed:
            failedSoFar +
            batchFailed,
        },
      };
    } catch (error) {
      console.error(
        "SALE badge apply error:",
        error,
      );

      return {
        success: false,
        intent,

        message:
          error instanceof
          Error
            ? error.message
            : "Unknown SALE badge update error.",

        apply: {
          completed:
            false,

          halted:
            true,

          total:
          job.changes,

          nextOffset:
          offset,

          processed:
          offset,

          updated:
          updatedSoFar,

          added:
          addedSoFar,

          removed:
          removedSoFar,

          skipped:
          skippedSoFar,

          failed:
          failedSoFar,
        },
      };
    }
  }

  return {
    success: false,

    intent,

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
    listTotal,
    page,
    totalPages,
    filter,
    storeHandle,
  } =
    useLoaderData();

  const navigate =
    useNavigate();

  const [searchParams] =
    useSearchParams();

  const dryRunFetcher =
    useFetcher();

  const applyFetcher =
    useFetcher();

  /*
  |--------------------------------------------------------------------------
  | Dry Run UI state
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

  const liveJob =
    dryRunFetcher.data
      ?.job ||
    job;

  /*
  |--------------------------------------------------------------------------
  | Apply UI state
  |--------------------------------------------------------------------------
  */

  const [
    autoApplying,
    setAutoApplying,
  ] =
    useState(false);

  const applyProgress =
    applyFetcher.data
      ?.apply ||
    null;

  /*
   * IMPORTANT:
   * Update all products is enabled ONLY
   * after a COMPLETED Dry Run with changes.
   */
  const canApply =
    job?.status ===
    "COMPLETED" &&
    job.changes > 0;

  /*
  |--------------------------------------------------------------------------
  | Automatic Dry Run processing
  |--------------------------------------------------------------------------
  */

  useEffect(() => {
    if (
      !autoScanning
    ) {
      return;
    }

    if (
      dryRunFetcher.state !==
      "idle"
    ) {
      return;
    }

    if (
      !liveJob ||
      liveJob.status !==
      "RUNNING"
    ) {
      setAutoScanning(
        false,
      );

      return;
    }

    const timer =
      window.setTimeout(
        () => {
          dryRunFetcher.submit(
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
        DRY_RUN_DELAY_MS,
      );

    return () =>
      window.clearTimeout(
        timer,
      );
  }, [
    autoScanning,
    liveJob,
    dryRunFetcher.state,
  ]);

  /*
   * Reload page after Dry Run completes.
   */
  useEffect(() => {
    const result =
      dryRunFetcher.data;

    if (
      !result?.job
    ) {
      return;
    }

    if (
      result.job.status ===
      "COMPLETED"
    ) {
      setAutoScanning(
        false,
      );

      navigate(
        "/app/sale-sync",
        {
          replace:
            true,
        },
      );
    }
  }, [
    dryRunFetcher.data,
    navigate,
  ]);

  /*
  |--------------------------------------------------------------------------
  | Automatic Apply processing
  |--------------------------------------------------------------------------
  */

  useEffect(() => {
    if (
      !autoApplying
    ) {
      return;
    }

    if (
      applyFetcher.state !==
      "idle"
    ) {
      return;
    }

    if (
      !applyProgress
    ) {
      return;
    }

    if (
      applyProgress.completed ||
      applyProgress.halted
    ) {
      setAutoApplying(
        false,
      );

      return;
    }

    const timer =
      window.setTimeout(
        () => {
          applyFetcher.submit(
            {
              intent:
                "processApply",

              jobId:
              job.id,

              offset:
                String(
                  applyProgress.nextOffset,
                ),

              updatedSoFar:
                String(
                  applyProgress.updated,
                ),

              addedSoFar:
                String(
                  applyProgress.added,
                ),

              removedSoFar:
                String(
                  applyProgress.removed,
                ),

              skippedSoFar:
                String(
                  applyProgress.skipped,
                ),

              failedSoFar:
                String(
                  applyProgress.failed,
                ),
            },
            {
              method:
                "post",
            },
          );
        },
        APPLY_DELAY_MS,
      );

    return () =>
      window.clearTimeout(
        timer,
      );
  }, [
    autoApplying,
    applyFetcher.state,
    applyProgress,
    job,
  ]);

  /*
  |--------------------------------------------------------------------------
  | Actions
  |--------------------------------------------------------------------------
  */

  function startDryRun() {
    if (
      dryRunFetcher.state !==
      "idle"
    ) {
      return;
    }

    setAutoApplying(
      false,
    );

    dryRunFetcher.submit(
      {
        intent:
          "startDryRun",
      },
      {
        method:
          "post",
      },
    );

    setAutoScanning(
      true,
    );
  }

  function startApply() {
    /*
     * Client-side protection.
     */
    if (
      !canApply ||
      !job
    ) {
      return;
    }

    const confirmed =
      window.confirm(
        `Update all detected SALE badge problems?\n\n` +
        `Products affected: ${affectedProducts}\n` +
        `Variants to process: ${job.changes}\n` +
        `ADD SALE: ${job.addCount}\n` +
        `REMOVE SALE: ${job.removeCount}\n\n` +
        `Every variant will be revalidated before updating.`,
      );

    if (!confirmed) {
      return;
    }

    setAutoApplying(
      true,
    );

    applyFetcher.submit(
      {
        intent:
          "processApply",

        jobId:
        job.id,

        offset:
          "0",

        updatedSoFar:
          "0",

        addedSoFar:
          "0",

        removedSoFar:
          "0",

        skippedSoFar:
          "0",

        failedSoFar:
          "0",
      },
      {
        method:
          "post",
      },
    );
  }

  function resumeApply() {
    if (
      !job ||
      !applyProgress
    ) {
      return;
    }

    setAutoApplying(
      true,
    );

    applyFetcher.submit(
      {
        intent:
          "processApply",

        jobId:
        job.id,

        offset:
          String(
            applyProgress.nextOffset,
          ),

        updatedSoFar:
          String(
            applyProgress.updated,
          ),

        addedSoFar:
          String(
            applyProgress.added,
          ),

        removedSoFar:
          String(
            applyProgress.removed,
          ),

        skippedSoFar:
          String(
            applyProgress.skipped,
          ),

        failedSoFar:
          String(
            applyProgress.failed,
          ),
      },
      {
        method:
          "post",
      },
    );
  }

  /*
  |--------------------------------------------------------------------------
  | Pagination + filters
  |--------------------------------------------------------------------------
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
        RESULT_PAGE_SIZE +
        1;

      const to =
        Math.min(
          page *
          RESULT_PAGE_SIZE,
          listTotal,
        );

      return `${from}-${to}`;
    }, [
      page,
      listTotal,
    ]);

  function buildListUrl(
    nextPage,
    nextFilter = filter,
  ) {
    const params =
      new URLSearchParams(
        searchParams,
      );

    params.set(
      "page",
      String(nextPage),
    );

    params.set(
      "filter",
      nextFilter,
    );

    return `/app/sale-sync?${params.toString()}`;
  }

  /*
  |--------------------------------------------------------------------------
  | UI computed state
  |--------------------------------------------------------------------------
  */

  const dryRunBusy =
    autoScanning ||
    dryRunFetcher.state !==
    "idle";

  const applyBusy =
    autoApplying ||
    applyFetcher.state !==
    "idle";

  const currentStatus =
    liveJob?.status ||
    "NOT_STARTED";

  const currentChecked =
    liveJob?.checked ??
    0;

  const currentChanges =
    liveJob?.changes ??
    0;

  const currentAdd =
    liveJob?.addCount ??
    0;

  const currentRemove =
    liveJob?.removeCount ??
    0;

  const currentFailed =
    liveJob?.failed ??
    0;

  return (
    <s-page heading="SALE badge sync">

      {/*
      |--------------------------------------------------------------------------
      | FULL DRY RUN
      |--------------------------------------------------------------------------
      */}

      <s-section heading="Full catalog dry run">
        <s-paragraph>
          This scan does not change Shopify data.
          It checks the full variant catalog in
          batches of {SHOPIFY_PAGE_SIZE} variants.
        </s-paragraph>

        <div
          style={{
            marginTop:
              "18px",

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
              dryRunBusy ||
              applyBusy
            }
            onClick={
              startDryRun
            }
            style={{
              ...primaryButtonStyle,

              opacity:
                dryRunBusy ||
                applyBusy
                  ? 0.5
                  : 1,

              cursor:
                dryRunBusy ||
                applyBusy
                  ? "not-allowed"
                  : "pointer",
            }}
          >
            {dryRunBusy
              ? "Scanning catalog..."
              : "Start full dry run"}
          </button>

          {autoScanning && (
            <button
              type="button"
              onClick={() => {
                setAutoScanning(
                  false,
                );
              }}
              style={
                secondaryButtonStyle
              }
            >
              Pause dry run
            </button>
          )}

          {!autoScanning &&
            liveJob?.status ===
            "RUNNING" && (
              <button
                type="button"
                onClick={() => {
                  setAutoScanning(
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
              currentFailed
            }
          />
        </div>

        {dryRunFetcher.data
          ?.message && (
          <div
            style={
              dryRunFetcher.data
                ?.success ===
              false
                ? errorBoxStyle
                : infoBoxStyle
            }
          >
            {
              dryRunFetcher
                .data
                .message
            }
          </div>
        )}

        {liveJob?.lastError && (
          <div
            style={
              errorBoxStyle
            }
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

      {/*
      |--------------------------------------------------------------------------
      | DETECTED CHANGES
      |--------------------------------------------------------------------------
      */}

      <s-section heading="Detected changes">

        {!job ? (
          <s-paragraph>
            Run the full catalog dry run to see the
            products that require SALE badge changes.
          </s-paragraph>
        ) : (
          <>
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

            {items.length ===
            0 ? (
              <div
                style={
                  emptyBoxStyle
                }
              >
                No detected changes for this filter.
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
                    <th style={cellStyle}>
                      Product
                    </th>

                    <th style={cellStyle}>
                      Variant
                    </th>

                    <th style={cellStyle}>
                      SKU
                    </th>

                    <th style={cellStyle}>
                      Price
                    </th>

                    <th style={cellStyle}>
                      Compare at
                    </th>

                    <th style={cellStyle}>
                      On sale?
                    </th>

                    <th style={cellStyle}>
                      SALE badge?
                    </th>

                    <th style={cellStyle}>
                      Action
                    </th>

                    <th style={cellStyle}>
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
                        <td style={cellStyle}>
                          {
                            item.productTitle
                          }
                        </td>

                        <td style={cellStyle}>
                          {
                            item.variantTitle
                          }
                        </td>

                        <td style={cellStyle}>
                          {item.sku ||
                            "-"}
                        </td>

                        <td style={cellStyle}>
                          {
                            item.price
                          }
                        </td>

                        <td style={cellStyle}>
                          {item.compareAtPrice ||
                            "-"}
                        </td>

                        <td style={cellStyle}>
                          {item.isOnSale
                            ? "YES"
                            : "NO"}
                        </td>

                        <td style={cellStyle}>
                          {item.hasSaleBadge
                            ? "YES"
                            : "NO"}
                        </td>

                        <td style={cellStyle}>
                          <strong>
                            {
                              item.action
                            }
                          </strong>
                        </td>

                        <td style={cellStyle}>
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

            {totalPages >
              1 && (
                <div
                  style={
                    paginationStyle
                  }
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
      </s-section>

      {/*
      |--------------------------------------------------------------------------
      | APPLY ALL
      |--------------------------------------------------------------------------
      |
      | This block is ALWAYS visible.
      |
      | The button is enabled ONLY after a successful
      | COMPLETED Dry Run with at least one change.
      |
      */}

      <s-section heading="Apply SALE badge changes">

        {job?.status ===
        "COMPLETED" ? (
          <s-paragraph>
            The completed dry run found{" "}
            <strong>
              {job.changes}
            </strong>{" "}
            variants across{" "}
            <strong>
              {
                affectedProducts
              }
            </strong>{" "}
            products that require an update.
          </s-paragraph>
        ) : (
          <s-paragraph>
            Complete the full catalog dry run before
            applying any SALE badge changes.
          </s-paragraph>
        )}

        <div
          style={
            statsGridStyle
          }
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
          style={
            infoBoxStyle
          }
        >
          Each variant is re-read from Shopify
          immediately before updating. All other
          badges are preserved. If the current state
          is already correct, that variant is skipped.
        </div>

        {applyProgress && (
          <>
            <div
              style={
                statsGridStyle
              }
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
          </>
        )}

        {applyFetcher.data
          ?.message && (
          <div
            style={
              applyFetcher.data
                ?.success
                ? successBoxStyle
                : errorBoxStyle
            }
          >
            {
              applyFetcher
                .data
                .message
            }
          </div>
        )}

        <div
          style={{
            marginTop:
              "20px",

            display:
              "flex",

            gap:
              "12px",

            alignItems:
              "center",

            flexWrap:
              "wrap",
          }}
        >
          {!applyProgress && (
            <button
              type="button"

              disabled={
                !canApply ||
                applyBusy ||
                dryRunBusy
              }

              onClick={
                startApply
              }

              style={{
                ...dangerButtonStyle,

                opacity:
                  !canApply ||
                  applyBusy ||
                  dryRunBusy
                    ? 0.5
                    : 1,

                cursor:
                  !canApply ||
                  applyBusy ||
                  dryRunBusy
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
            <>
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
                Updating products...
              </strong>
            </>
          )}

          {applyProgress &&
            !applyProgress.completed &&
            !autoApplying && (
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
            )}
        </div>

        {applyProgress
          ?.completed && (
          <div
            style={
              successBoxStyle
            }
          >
            <strong>
              Update completed.
            </strong>

            <div
              style={{
                marginTop:
                  "6px",
              }}
            >
              Run a new Full catalog dry run to
              verify the final state of the store.
            </div>
          </div>
        )}
      </s-section>
    </s-page>
  );
}

/*
|--------------------------------------------------------------------------
| UI components
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

        color:
          "#202223",

        background:
          active
            ? "#f1f8f5"
            : "#fff",

        fontWeight:
          active
            ? 700
            : 400,
      }}
    >
      {children}
    </Link>
  );
}

function ProgressBar({
                       current = 0,
                       total = 0,
                     }) {
  const percentage =
    total > 0
      ? Math.min(
        100,

        Math.round(
          (
            current /
            total
          ) *
          100,
        ),
      )
      : 0;

  return (
    <div
      style={{
        marginTop:
          "16px",
      }}
    >
      <div
        style={{
          display:
            "flex",

          justifyContent:
            "space-between",

          marginBottom:
            "6px",

          fontSize:
            "13px",
        }}
      >
        <span>
          Progress
        </span>

        <strong>
          {percentage}%
        </strong>
      </div>

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
              `${percentage}%`,

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
  marginTop:
    "16px",

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

const emptyBoxStyle = {
  padding:
    "20px",

  border:
    "1px solid #ddd",

  borderRadius:
    "8px",
};
