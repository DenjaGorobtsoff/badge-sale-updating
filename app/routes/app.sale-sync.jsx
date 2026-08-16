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

  const price = Number(variant.price);

  const compareAtPrice =
    variant.compareAtPrice !== null
      ? Number(variant.compareAtPrice)
      : null;

  const isOnSale =
    compareAtPrice !== null &&
    compareAtPrice > price;

  const hasSaleBadge =
    badges.includes(SALE_BADGE_GID);

  let action = "NONE";

  if (isOnSale && !hasSaleBadge) {
    action = "ADD_SALE";
  }

  if (!isOnSale && hasSaleBadge) {
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

export const loader = async ({ request }) => {
  const { admin, session } =
    await authenticate.admin(request);

  const response = await admin.graphql(
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

  const json = await response.json();

  if (json.errors) {
    console.error(json.errors);

    throw new Response(
      JSON.stringify(json.errors),
      { status: 500 },
    );
  }

  const allVariants =
    json.data.productVariants.nodes.map(
      (variant) => {
        const analysis =
          analyseVariant(variant);

        return {
          id: variant.id,

          variantNumericId:
            variant.id.split("/").pop(),

          productNumericId:
            variant.product.id
              .split("/")
              .pop(),

          productTitle:
          variant.product.title,

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
        variant.action !== "NONE",
    );

  return {
    variants,

    stats: {
      checked:
      allVariants.length,

      problems:
      variants.length,

      add:
      variants.filter(
        (variant) =>
          variant.action ===
          "ADD_SALE",
      ).length,

      remove:
      variants.filter(
        (variant) =>
          variant.action ===
          "REMOVE_SALE",
      ).length,
    },

    pageInfo:
    json.data.productVariants.pageInfo,

    storeHandle:
      session.shop.replace(
        ".myshopify.com",
        "",
      ),
  };
};

export const action = async ({ request }) => {
  const { admin } =
    await authenticate.admin(request);

  const formData =
    await request.formData();

  const variantId =
    formData.get("variantId");

  if (
    !variantId ||
    typeof variantId !== "string" ||
    !variantId.startsWith(
      "gid://shopify/ProductVariant/",
    )
  ) {
    return {
      success: false,
      message:
        "Invalid variant ID.",
    };
  }

  /*
   * IMPORTANT:
   * We re-read the variant here.
   *
   * We do NOT trust the data that was
   * previously displayed by the loader.
   */
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

  if (json.errors) {
    console.error(json.errors);

    return {
      success: false,
      message:
        "Could not read the variant.",
    };
  }

  const variant =
    json.data.productVariant;

  if (!variant) {
    return {
      success: false,
      message:
        "Variant was not found.",
    };
  }

  const analysis =
    analyseVariant(variant);

  if (analysis.action === "NONE") {
    return {
      success: true,
      message:
        `${variant.product.title} / ${variant.title}: no update is required.`,
    };
  }

  let nextBadges;

  if (
    analysis.action === "ADD_SALE"
  ) {
    nextBadges = [
      ...analysis.badges,
      SALE_BADGE_GID,
    ];
  } else {
    nextBadges =
      analysis.badges.filter(
        (gid) =>
          gid !== SALE_BADGE_GID,
      );
  }

  /*
   * Defensive deduplication.
   * This does not affect other badges.
   */
  nextBadges = [
    ...new Set(nextBadges),
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
      JSON.stringify(nextBadges),
  };

  /*
   * If the metafield already exists,
   * compareDigest prevents us from
   * overwriting a concurrent change.
   */
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
            metafields: $metafields
          ) {
            metafields {
              id
              namespace
              key
              type
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
            metafieldInput,
          ],
        },
      },
    );

  const mutationJson =
    await mutationResponse.json();

  if (mutationJson.errors) {
    console.error(
      mutationJson.errors,
    );

    return {
      success: false,
      message:
        "GraphQL mutation failed.",
    };
  }

  const result =
    mutationJson.data
      .metafieldsSet;

  if (
    result.userErrors?.length
  ) {
    console.error(
      result.userErrors,
    );

    return {
      success: false,

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

    action:
    analysis.action,

    variantId:
    variant.id,

    message:
      `${analysis.action} completed for ${variant.product.title} / ${variant.title}.`,
  };
};

export default function SaleSyncPage() {
  const {
    variants,
    stats,
    pageInfo,
    storeHandle,
  } = useLoaderData();

  const actionData =
    useActionData();

  const navigation =
    useNavigation();

  const submittingVariantId =
    navigation.formData?.get(
      "variantId",
    );

  return (
    <s-page heading="SALE badge sync">
      <s-section heading="Dry run / Single variant test">
        <s-paragraph>
          Only one variant is changed when
          you press Apply. No batch update
          exists on this page yet.
        </s-paragraph>

        {actionData?.message && (
          <div
            style={{
              marginTop: "16px",
              marginBottom: "16px",
              padding: "12px 16px",
              border: `1px solid ${
                actionData.success
                  ? "#008060"
                  : "#d82c0d"
              }`,
              borderRadius: "8px",
            }}
          >
            <strong>
              {actionData.success
                ? "Success"
                : "Error"}
            </strong>

            <div>
              {actionData.message}
            </div>
          </div>
        )}

        <div
          style={{
            display: "flex",
            gap: "20px",
            marginTop: "20px",
            marginBottom: "20px",
            flexWrap: "wrap",
          }}
        >
          <strong>
            Checked: {stats.checked}
          </strong>

          <strong>
            Problems: {stats.problems}
          </strong>

          <strong>
            Add SALE: {stats.add}
          </strong>

          <strong>
            Remove SALE: {stats.remove}
          </strong>
        </div>

        {variants.length === 0 ? (
          <div
            style={{
              padding: "20px",
              border: "1px solid #ddd",
              borderRadius: "8px",
            }}
          >
            No incorrect SALE badges were
            found in these variants.
          </div>
        ) : (
          <div
            style={{
              overflowX: "auto",
            }}
          >
            <table
              style={{
                width: "100%",
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
                  Variant ID
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

                <th style={cellStyle}>
                  Test
                </th>
              </tr>
              </thead>

              <tbody>
              {variants.map(
                (variant) => {
                  const isSubmitting =
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
                            name="variantId"
                            value={
                              variant.id
                            }
                          />

                          <button
                            type="submit"
                            disabled={
                              isSubmitting
                            }
                            style={{
                              padding:
                                "8px 14px",
                              cursor:
                                isSubmitting
                                  ? "wait"
                                  : "pointer",
                            }}
                          >
                            {isSubmitting
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
            marginTop: "20px",
            fontSize: "13px",
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
