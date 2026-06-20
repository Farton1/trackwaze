const https = require('https');
const fs = require('fs');
const path = require('path');

const PRINTIFY_KEY = process.env.PRINTIFY_API_KEY;
const SHOP_ID = process.env.PRINTIFY_SHOP_ID;
const STRIPE_KEY = process.env.STRIPE_SECRET_KEY;
const PRICE_CENTS = parseInt(process.env.PRODUCT_PRICE_CENTS || '2999', 10);

// Shipping countries for Stripe Payment Links
const SHIP_COUNTRIES = [
  'US','CA','GB','AU','NZ','IE','DE','FR','NL','SE','NO','DK','FI',
  'AT','BE','CH','ES','IT','PT','PL','CZ','JP','KR','SG','MX','BR',
];

if (!PRINTIFY_KEY || !SHOP_ID) {
  console.log('PRINTIFY_API_KEY or PRINTIFY_SHOP_ID not set — skipping sync');
  process.exit(0);
}

// ─── HTTP helpers ────────────────────────────────────────────────────────────

function httpGet(hostname, path, headers) {
  return new Promise((resolve, reject) => {
    https.get({ hostname, path, headers }, res => {
      let body = '';
      res.on('data', d => (body += d));
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error(`JSON parse failed: ${body.slice(0, 200)}`)); }
      });
    }).on('error', reject);
  });
}

function printifyPost(path, body) {
  const data = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.printify.com',
      path,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${PRINTIFY_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        'User-Agent': 'TrackWaze/1.0',
      },
    }, res => {
      let out = '';
      res.on('data', d => (out += d));
      res.on('end', () => { try { resolve(JSON.parse(out)); } catch (e) { resolve({}); } });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function stripePost(endpoint, params) {
  const body = new URLSearchParams(params).toString();
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.stripe.com',
      path: endpoint,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${STRIPE_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
    }, res => {
      let data = '';
      res.on('data', d => (data += d));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(data.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ─── Stripe: create product → price → payment link ───────────────────────────

async function createStripeLink(title, description) {
  const product = await stripePost('/v1/products', {
    name: `${title} — TrackWaze Desk Mat`,
    description: description || title,
  });
  if (product.error) throw new Error(`Stripe product error: ${product.error.message}`);

  const price = await stripePost('/v1/prices', {
    product: product.id,
    unit_amount: PRICE_CENTS,
    currency: 'usd',
  });
  if (price.error) throw new Error(`Stripe price error: ${price.error.message}`);

  const linkParams = {
    'line_items[0][price]': price.id,
    'line_items[0][quantity]': '1',
  };
  SHIP_COUNTRIES.forEach((c, i) => {
    linkParams[`shipping_address_collection[allowed_countries][${i}]`] = c;
  });

  const link = await stripePost('/v1/payment_links', linkParams);
  if (link.error) throw new Error(`Stripe link error: ${link.error.message}`);

  return link.url;
}

// ─── Printify helpers ─────────────────────────────────────────────────────────

function extractSize(title) {
  if (/\bXXL\b/i.test(title)) return 'XXL';
  if (/\bXL\b/i.test(title)) return 'XL';
  if (/\bLarge\b|\bL\b/i.test(title)) return 'L';
  if (/\bSmall\b|\bS\b/i.test(title)) return 'S';
  // For desk mats: capture full dimension like "36" × 18"" or "16 x 24 inches"
  const dim = title.match(/(\d+[""]?\s*[×xX]\s*\d+[""]?(\s*(?:in(?:ches?)?|cm))?)/i);
  if (dim) return dim[1].replace(/\s+/g, ' ').trim();
  return title.trim();
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  // Load existing products.json to preserve already-created Stripe URLs
  const outPath = path.join(__dirname, '..', 'products.json');
  let existingLinks = {};
  try {
    const prev = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    prev.forEach(p => { if (p.stripeUrl) existingLinks[String(p.id)] = p.stripeUrl; });
    console.log(`Loaded ${Object.keys(existingLinks).length} existing Stripe links`);
  } catch (e) { /* first run or empty file */ }

  // Auto-detect the correct shop ID by name (falls back to SHOP_ID env var)
  const shops = await httpGet('api.printify.com', '/v1/shops.json',
    { Authorization: `Bearer ${PRINTIFY_KEY}`, 'User-Agent': 'TrackWaze/1.0' });
  const shopList = Array.isArray(shops) ? shops : [];
  const match = shopList.find(s => s.title.toLowerCase().includes('trackwaze'))
    || shopList.find(s => s.id === parseInt(SHOP_ID))
    || shopList[0];
  const resolvedShopId = match ? match.id : SHOP_ID;
  console.log(`Using shop: "${match ? match.title : 'unknown'}" (${resolvedShopId})`);

  // Fetch from Printify
  const data = await httpGet('api.printify.com',
    `/v1/shops/${resolvedShopId}/products.json?limit=50`,
    { Authorization: `Bearer ${PRINTIFY_KEY}`, 'User-Agent': 'TrackWaze/1.0' }
  );
  const all = data.data || [];
  console.log(`Printify returned ${all.length} total products`);

  // Auto-publish any products still pending (custom integrations require this)
  for (const p of all.filter(p => !p.is_enabled)) {
    console.log(`  Publishing "${p.title}"...`);
    try {
      await printifyPost(`/v1/shops/${resolvedShopId}/products/${p.id}/publish.json`, {
        title: true, description: true, images: true,
        variants: true, tags: true, keyFeatures: true, shipping_template: true,
      });
      await printifyPost(`/v1/shops/${resolvedShopId}/products/${p.id}/publishing_succeeded.json`, {
        external: {
          id: String(p.id),
          handle: p.title.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
        },
      });
      console.log(`  ✓ Published "${p.title}"`);
      p.is_enabled = true;
    } catch (err) {
      console.error(`  ✗ Failed to publish "${p.title}": ${err.message}`);
    }
  }

  const products = [];
  for (const p of all) {
    const tags = (p.tags || []).map(t => t.toLowerCase().trim());

    // Skip non-desk-mat products (e.g. candles accidentally in the shop)
    const titleLower = p.title.toLowerCase();
    const isDesktMat = titleLower.includes('mat') || titleLower.includes('pad') || tags.includes('include');
    if (!isDesktMat) {
      console.log(`  Skipping "${p.title}" (not a desk mat — add tag "include" to force-include)`);
      continue;
    }

    const cats = tags.filter(t => t.startsWith('cat:')).map(t => t.slice(4));

    // Largest (highest-priced) variant only
    const enabled = p.variants.filter(v => v.is_enabled);
    if (!enabled.length) continue;
    const largest = enabled.reduce((best, v) => v.price > best.price ? v : best, enabled[0]);
    const size = extractSize(largest.title);
    const price = (largest.price / 100).toFixed(2);

    // Stripe URL — reuse existing or auto-create
    let stripeUrl = existingLinks[String(p.id)] || null;
    if (!stripeUrl && STRIPE_KEY) {
      try {
        console.log(`  Creating Stripe link for "${p.title}"...`);
        stripeUrl = await createStripeLink(p.title, (p.description || '').replace(/<[^>]*>/g, '').trim().slice(0, 500));
        console.log(`  → ${stripeUrl}`);
      } catch (err) {
        console.error(`  Stripe error for "${p.title}": ${err.message}`);
      }
    }

    const defaultImg = p.images.find(img => img.is_default) || p.images[0];
    products.push({
      id: p.id,
      title: p.title,
      description: (p.description || '').replace(/<[^>]*>/g, '').trim(),
      image: defaultImg ? defaultImg.src : null,
      images: p.images.slice(0, 4).map(img => img.src),
      categories: cats.length ? cats : ['tech'],
      stripeUrl,
      variants: [{ size, price, stripeUrl }],
      sizes: [size],
      price,
      isNew: tags.includes('new'),
      isBestSeller: tags.includes('bestseller'),
    });
  }

  fs.writeFileSync(outPath, JSON.stringify(products, null, 2));
  console.log(`Synced ${products.length} products → products.json`);
}

main().catch(err => { console.error(err); process.exit(1); });
