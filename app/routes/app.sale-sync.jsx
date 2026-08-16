import {
  Form,
  useActionData,
  useLoaderData,
  useNavigation,
} from "react-router";

import { authenticate } from "../shopify.server";

const SALE_BADGE_GID =
  "gid://shopify/Metaobject/92904096052";

const BADGE_NAMESPACE = "custom";
const BADGE_KEY = "product_badges";
const BADGE_TYPE = "list.metaobject_reference";

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
    badges,
    price,
    compareAtPrice,
    isOnSale,
    hasSaleBadge,
    action,
  };
}

async function updateSingleVariant(
  admin,
  variantId,
) {
  const response =
    await admin.graphql(
      `#graphql
        query VariantForSaleBadgeUpdate(
          $id: ID!
        ) {
          productVariant(id: $id) {
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
      `,
      {
        variables: {
          id: variantId,
        },
      },
    );

  const json =
    await response.json();

  if (
    json.errors?.length
  ) {
    console.error(
      "Variant read errors:",
      json.errors,
    );

    return {
      success: false,
      skipped: false,
      variantId,
      action: null,
      message:
        "Could not read variant.",
    };
  }

  const variant =
    json.data.productVariant;

  if (!variant) {
    return {
      success: false,
      skipped: false,
      variantId,
      action: null,
      message:
        "Variant was not found.",
    };
  }

  const analysis =
    analyseVariant(variant);

  if (
    analysis.action ===
    "NONE"
  ) {
    return {
      success: true,
      skipped: true,
      variantId,
      action: "NONE",
      message:
        `${variant.product.title} / ` +
        `${variant.title}: ` +
        `no update required.`,
    };
  }

  let nextBadges;

  if (
    analysis.action ===
    "ADD_SALE"
  ) {
    nextBadges = [
      ...analysis.badges,
      SALE_BADGE_GID,
    ];
  } else {
    nextBadges =
      analysis.badges.filter(
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

  const metafieldInput = {
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

  if (
    variant.metafield
      ?.compareDigest
  ) {
    metafieldInput.compareDigest =
      variant.metafield
        .compareDigest;
  }

  const mutationResponse =
    await admin.graphql(
      `#graphql
        mutation UpdateSaleBadge(
          $metafields:
            [MetafieldsSetInput!]!
        ) {
          metafieldsSet(
            metafields:
              $metafields
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
          metafields: [
            metafieldInput,
          ],
        },
      },
    );

  const mutationJson =
    await mutationResponse.json();

  if (
    mutationJson.errors
      ?.length
  ) {
    console.error(
      "Mutation errors:",
      mutationJson.errors,
    );

    return {
      success: false,
      skipped: false,
      variantId:
      variant.id,
      action:
      analysis.action,
      message:
        "GraphQL mutation failed.",
    };
  }

  const result =
    mutationJson.data
      .metafieldsSet;

  if (
    result.userErrors
      ?.length
  ) {
    console.error(
      "MetafieldsSet errors:",
      result.userErrors,
    );

    return {
      success: false,
      skipped: false,
      variantId:
      variant.id,
      action:
      analysis.action,
      message:
        result.userErrors
          .map(
            (error) =>
              error.message,
          )
          .join(", "),
    };
  }

  return {
    success: true,
    skipped: false,
    variantId:
    variant.id,
    action:
    analysis.action,

    message:
      `${analysis.action} completed for ` +
      `${variant.product.title} / ` +
      `${variant.title}.`,
  };
}

export const loader =
  async ({ request }) => {
    const {
      admin,
      session,
    } =
      await authenticate.admin(
        request,
      );

    const response =
      await admin.graphql(
        `#graphql
          query SaleBadgeDryRun {
            productVariants(
              first: 250
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
      );

    const json =
      await response.json();

    if (
      json.errors?.length
    ) {
      console.error(
        "Loader errors:",
        json.errors,
      );

      throw new Response(
        JSON.stringify(
          json.errors,
        ),
        {
          status: 500,
        },
      );
    }

    const allVariants =
      json.data
        .productVariants
        .nodes
        .map(
          (variant) => {
            const analysis =
              analyseVariant(
                variant,
              );

            return {
              id:
              variant.id,

              variantNumericId:
                variant.id
                  .split("/")
                  .pop(),

              productNumericId:
                variant.product.id
                  .split("/")
                  .pop(),

              productTitle:
              variant.product
                .title,

              variantTitle:
              variant.title,

              sku:
              variant.sku,

              price:
              variant.price,

              compareAtPrice:
              variant.compareAtPrice,

              badges:
              analysis.badges,

              isOnSale:
              analysis.isOnSale,

              hasSaleBadge:
              analysis.hasSaleBadge,

              action:
              analysis.action,
            };
          },
        );

    const variants =
      allVariants.filter(
        (variant) =>
          variant.action !==
          "NONE",
      );

    const addCount =
      variants.filter(
        (variant) =>
          variant.action ===
          "ADD_SALE",
      ).length;

    const removeCount =
      variants.filter(
        (variant) =>
          variant.action ===
          "REMOVE_SALE",
      ).length;

    const storeHandle =
      session.shop.replace(
        ".myshopify.com",
        "",
      );

    return {
      variants,

      stats: {
        checked:
        allVariants.length,

        problems:
        variants.length,

        add:
        addCount,

        remove:
        removeCount,
      },

      pageInfo:
      json.data
        .productVariants
        .pageInfo,

      storeHandle,
    };
  };

export const action =
  async ({ request }) => {
    const { admin } =
      await authenticate.admin(
        request,
      );

    const formData =
      await request.formData();

    const intent =
      formData.get(
        "intent",
      );

    if (
      intent === "single"
    ) {
      const variantId =
        formData.get(
          "variantId",
        );

      if (
        !variantId ||
        typeof variantId !==
        "string" ||
        !variantId.startsWith(
          "gid://shopify/ProductVariant/",
        )
      ) {
        return {
          success: false,
          mode: "single",

          message:
            "Invalid variant ID.",
        };
      }

      const result =
        await updateSingleVariant(
          admin,
          variantId,
        );

      return {
        success:
        result.success,

        mode: "single",

        result,

        message:
        result.message,
      };
    }

    if (
      intent === "batch10"
    ) {
      const variantIds =
        formData
          .getAll(
            "variantIds",
          )
          .filter(
            (id) =>
              typeof id ===
              "string" &&
              id.startsWith(
                "gid://shopify/ProductVariant/",
              ),
          )
          .slice(
            0,
            10,
          );

      if (
        variantIds.length ===
        0
      ) {
        return {
          success: false,
          mode: "batch",

          message:
            "No variants were selected.",
        };
      }

      const results = [];

      for (
        const variantId
        of variantIds
        ) {
        try {
          const result =
            await updateSingleVariant(
              admin,
              variantId,
            );

          results.push(
            result,
          );
        } catch (error) {
          console.error(
            "Batch item error:",
            error,
          );

          results.push({
            success: false,
            skipped: false,
            variantId,
            action: null,

            message:
              error instanceof
              Error
                ? error.message
                : "Unknown error.",
          });
        }
      }

      const updatedCount =
        results.filter(
          (item) =>
            item.success &&
            !item.skipped,
        ).length;

      const skippedCount =
        results.filter(
          (item) =>
            item.skipped,
        ).length;

      const failedCount =
        results.filter(
          (item) =>
            !item.success,
        ).length;

      return {
        success:
          failedCount ===
          0,

        mode: "batch",

        results,

        stats: {
          requested:
          variantIds.length,

          updated:
          updatedCount,

          skipped:
          skippedCount,

          failed:
          failedCount,
        },

        message:
          `Batch finished. ` +
          `Updated: ${updatedCount}, ` +
          `Skipped: ${skippedCount}, ` +
          `Failed: ${failedCount}.`,
      };
    }

    return {
      success: false,

      message:
        "Unknown action.",
    };
  };

export default function SaleSyncPage() {
  const {
    variants,
    stats,
    pageInfo,
    storeHandle,
  } =
    useLoaderData();

  const actionData =
    useActionData();

  const navigation =
    useNavigation();

  const submittingIntent =
    navigation.formData?.get(
      "intent",
    );

  const submittingVariantId =
    navigation.formData?.get(
      "variantId",
    );

  const isBatchSubmitting =
    navigation.state ===
    "submitting" &&
    submittingIntent ===
    "batch10";

  return (
    <s-page heading="SALE badge sync">
      <s-section heading="Dry run / Controlled update">
        <s-paragraph>
          The first 250 variants are checked.
          Only variants with an incorrect SALE badge
          state are displayed.
        </s-paragraph>

        <s-paragraph>
          You can update one variant at a time or apply
          the first 10 detected problems.
        </s-paragraph>

        {actionData?.message && (
          <div
            style={{
              marginTop: "16px",
              marginBottom:
                "16px",
              padding:
                "12px 16px",

              border: `1px solid ${
                actionData.success
                  ? "#008060"
                  : "#d82c0d"
              }`,

              borderRadius:
                "8px",

              background:
                actionData.success
                  ? "#f1f8f5"
                  : "#fff4f4",
            }}
          >
            <strong>
              {actionData.success
                ? "Success"
                : "Result"}
            </strong>

            <div
              style={{
                marginTop:
                  "4px",
              }}
            >
              {
                actionData.message
              }
            </div>
          </div>
        )}

        {actionData?.mode ===
          "batch" &&
          actionData.stats && (
            <div
              style={{
                marginBottom:
                  "20px",

                padding:
                  "14px 16px",

                border:
                  "1px solid #ddd",

                borderRadius:
                  "8px",
              }}
            >
              <strong>
                Batch result
              </strong>

              <div
                style={{
                  display:
                    "flex",
                  gap: "20px",
                  flexWrap:
                    "wrap",

                  marginTop:
                    "10px",
                }}
              >
                <span>
                  Requested:{" "}
                  {
                    actionData
                      .stats
                      .requested
                  }
                </span>

                <span>
                  Updated:{" "}
                  {
                    actionData
                      .stats
                      .updated
                  }
                </span>

                <span>
                  Skipped:{" "}
                  {
                    actionData
                      .stats
                      .skipped
                  }
                </span>

                <span>
                  Failed:{" "}
                  {
                    actionData
                      .stats
                      .failed
                  }
                </span>
              </div>
            </div>
          )}

        <div
          style={{
            display: "flex",
            gap: "20px",
            marginTop:
              "20px",
            marginBottom:
              "20px",
            flexWrap: "wrap",
          }}
        >
          <strong>
            Checked:{" "}
            {stats.checked}
          </strong>

          <strong>
            Problems:{" "}
            {stats.problems}
          </strong>

          <strong>
            Add SALE:{" "}
            {stats.add}
          </strong>

          <strong>
            Remove SALE:{" "}
            {stats.remove}
          </strong>
        </div>

        {variants.length >
          0 && (
            <Form
              method="post"
            >
              <input
                type="hidden"
                name="intent"
                value="batch10"
              />

              {variants
                .slice(
                  0,
                  10,
                )
                .map(
                  (
                    variant,
                  ) => (
                    <input
                      key={
                        variant.id
                      }
                      type="hidden"
                      name="variantIds"
                      value={
                        variant.id
                      }
                    />
                  ),
                )}

              <button
                type="submit"
                disabled={
                  navigation.state ===
                  "submitting"
                }
                style={{
                  padding:
                    "10px 16px",

                  marginBottom:
                    "20px",

                  fontWeight:
                    600,

                  cursor:
                    navigation.state ===
                    "submitting"
                      ? "wait"
                      : "pointer",
                }}
              >
                {isBatchSubmitting
                  ? "Applying batch..."
                  : `Apply first ${Math.min(
                    variants.length,
                    10,
                  )} problems`}
              </button>
            </Form>
          )}

        {variants.length ===
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
            No incorrect SALE
            badges were found
            in these variants.
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
                  Admin
                </th>

                <th
                  style={
                    cellStyle
                  }
                >
                  Update
                </th>
              </tr>
              </thead>

              <tbody>
              {variants.map(
                (variant) => {
                  const isSingleSubmitting =
                    navigation.state ===
                    "submitting" &&
                    submittingIntent ===
                    "single" &&
                    submittingVariantId ===
                    variant.id;

                  return (
                    <tr
                      key={
                        variant.id
                      }
                    >
                      <td
                        style={
                          cellStyle
                        }
                      >
                        {
                          variant.productTitle
                        }
                      </td>

                      <td
                        style={
                          cellStyle
                        }
                      >
                        {
                          variant.variantTitle
                        }
                      </td>

                      <td
                        style={
                          cellStyle
                        }
                      >
                        {
                          variant.variantNumericId
                        }
                      </td>

                      <td
                        style={
                          cellStyle
                        }
                      >
                        {variant.sku ||
                          "-"}
                      </td>

                      <td
                        style={
                          cellStyle
                        }
                      >
                        {
                          variant.price
                        }
                      </td>

                      <td
                        style={
                          cellStyle
                        }
                      >
                        {variant.compareAtPrice ||
                          "-"}
                      </td>

                      <td
                        style={
                          cellStyle
                        }
                      >
                        {variant.isOnSale
                          ? "YES"
                          : "NO"}
                      </td>

                      <td
                        style={
                          cellStyle
                        }
                      >
                        {variant.hasSaleBadge
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
                            variant.action
                          }
                        </strong>
                      </td>

                      <td
                        style={
                          cellStyle
                        }
                      >
                        <a
                          href={`https://admin.shopify.com/store/${storeHandle}/products/${variant.productNumericId}/variants/${variant.variantNumericId}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Open
                        </a>
                      </td>

                      <td
                        style={
                          cellStyle
                        }
                      >
                        <Form
                          method="post"
                        >
                          <input
                            type="hidden"
                            name="intent"
                            value="single"
                          />

                          <input
                            type="hidden"
                            name="variantId"
                            value={
                              variant.id
                            }
                          />

                          <button
                            type="submit"
                            disabled={
                              navigation.state ===
                              "submitting"
                            }
                            style={{
                              padding:
                                "8px 14px",

                              cursor:
                                navigation.state ===
                                "submitting"
                                  ? "wait"
                                  : "pointer",
                            }}
                          >
                            {isSingleSubmitting
                              ? "Applying..."
                              : "Apply"}
                          </button>
                        </Form>
                      </td>
                    </tr>
                  );
                },
              )}
              </tbody>
            </table>
          </div>
        )}

        <div
          style={{
            marginTop:
              "20px",

            fontSize:
              "13px",
          }}
        >
          More variants available:{" "}
          {pageInfo.hasNextPage
            ? "YES"
            : "NO"}
        </div>
      </s-section>
    </s-page>
  );
}

const cellStyle = {
  padding: "10px",
  borderBottom:
    "1px solid #ddd",
  textAlign: "left",
  whiteSpace: "nowrap",
};
