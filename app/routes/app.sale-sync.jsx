import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";

const SALE_BADGE_GID =
  "gid://shopify/Metaobject/92904096052";

const BADGE_NAMESPACE = "custom";
const BADGE_KEY = "product_badges";

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);

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
    json.data.productVariants.nodes.map((variant) => {
      let badges = [];

      if (variant.metafield?.value) {
        try {
          badges = JSON.parse(
            variant.metafield.value,
          );
        } catch {
          badges = [];
        }
      }

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
        id: variant.id,
        productTitle: variant.product.title,
        variantTitle: variant.title,
        sku: variant.sku,
        price: variant.price,
        compareAtPrice: variant.compareAtPrice,
        badges,
        isOnSale,
        hasSaleBadge,
        action,
      };
    });

  const variantsWithProblems =
    allVariants.filter(
      (variant) => variant.action !== "NONE",
    );

  const addCount =
    variantsWithProblems.filter(
      (variant) => variant.action === "ADD_SALE",
    ).length;

  const removeCount =
    variantsWithProblems.filter(
      (variant) => variant.action === "REMOVE_SALE",
    ).length;

  return {
    variants: variantsWithProblems,
    stats: {
      checked: allVariants.length,
      problems: variantsWithProblems.length,
      add: addCount,
      remove: removeCount,
    },
    pageInfo: json.data.productVariants.pageInfo,
  };
};

export default function SaleSyncPage() {
  const {
    variants,
    stats,
    pageInfo,
  } = useLoaderData();

  return (
    <s-page heading="SALE badge sync">
      <s-section heading="Dry run">
        <s-paragraph>
          No data is changed. The first 250 variants
          are analysed and only incorrect SALE badge
          states are displayed.
        </s-paragraph>

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
            No incorrect SALE badges were found
            in these variants.
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
                borderCollapse: "collapse",
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
              </tr>
              </thead>

              <tbody>
              {variants.map((variant) => (
                <tr key={variant.id}>
                  <td style={cellStyle}>
                    {variant.productTitle}
                  </td>

                  <td style={cellStyle}>
                    {variant.variantTitle}
                  </td>

                  <td style={cellStyle}>
                    {variant.sku || "-"}
                  </td>

                  <td style={cellStyle}>
                    {variant.price}
                  </td>

                  <td style={cellStyle}>
                    {variant.compareAtPrice || "-"}
                  </td>

                  <td style={cellStyle}>
                    {variant.isOnSale
                      ? "YES"
                      : "NO"}
                  </td>

                  <td style={cellStyle}>
                    {variant.hasSaleBadge
                      ? "YES"
                      : "NO"}
                  </td>

                  <td style={cellStyle}>
                    <strong>
                      {variant.action}
                    </strong>
                  </td>
                </tr>
              ))}
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
          {pageInfo.hasNextPage ? "YES" : "NO"}
        </div>
      </s-section>
    </s-page>
  );
}

const cellStyle = {
  padding: "10px",
  borderBottom: "1px solid #ddd",
  textAlign: "left",
  whiteSpace: "nowrap",
};
