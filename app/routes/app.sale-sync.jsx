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
        productVariants(first: 10, sortKey: ID) {
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
        }
      }
    `,
  );

  const json = await response.json();

  if (json.errors) {
    throw new Response(JSON.stringify(json.errors), {
      status: 500,
    });
  }

  const variants = json.data.productVariants.nodes.map((variant) => {
    let badges = [];

    if (variant.metafield?.value) {
      try {
        badges = JSON.parse(variant.metafield.value);
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

  return {
    variants,
  };
};

export default function SaleSyncPage() {
  const { variants } = useLoaderData();

  return (
    <s-page heading="SALE badge sync">
      <s-section heading="Dry run">
        <s-paragraph>
          No data is changed. The first 10 variants are only analysed.
        </s-paragraph>

        <div
          style={{
            overflowX: "auto",
            marginTop: "20px",
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
              <th style={cellStyle}>Product</th>
              <th style={cellStyle}>Variant</th>
              <th style={cellStyle}>SKU</th>
              <th style={cellStyle}>Price</th>
              <th style={cellStyle}>Compare at</th>
              <th style={cellStyle}>On sale?</th>
              <th style={cellStyle}>SALE badge?</th>
              <th style={cellStyle}>Action</th>
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
                  {variant.isOnSale ? "YES" : "NO"}
                </td>

                <td style={cellStyle}>
                  {variant.hasSaleBadge ? "YES" : "NO"}
                </td>

                <td style={cellStyle}>
                  <strong>{variant.action}</strong>
                </td>
              </tr>
            ))}
            </tbody>
          </table>
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
