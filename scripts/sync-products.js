const https = require('https');
const fs = require('fs');
const path = require('path');

const API_KEY = process.env.PRINTIFY_API_KEY;
const SHOP_ID = process.env.PRINTIFY_SHOP_ID;

if (!API_KEY || !SHOP_ID) {
  console.log('PRINTIFY_API_KEY or PRINTIFY_SHOP_ID not set — skipping sync');
  process.exit(0);
}

function get(url) {
  return new Promise((resolve, reject) => {
    const opts = { headers: { Authorization: `Bearer ${API_KEY}`, 'User-Agent': 'TrackWaze/1.0' } };
    https.get(url, opts, res => {
      let body = '';
      res.on('data', d => (body += d));
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error(`JSON parse failed: ${body.slice(0, 200)}`)); }
      });
    }).on('error', reject);
  });
}

function extractSize(title) {
  if (/\bXXL\b/i.test(title)) return 'XXL';
  if (/\bXL\b/i.test(title)) return 'XL';
  if (/\bLarge\b|\bL\b/i.test(title)) return 'L';
  if (/\bSmall\b|\bS\b/i.test(title)) return 'S';
  return title.split('/')[0].split('×')[0].trim().split(' ')[0];
}

async function main() {
  console.log(`Fetching products for shop ${SHOP_ID}...`);
  const data = await get(
    `https://api.printify.com/v1/shops/${SHOP_ID}/products.json?limit=100`
  );

  const products = (data.data || [])
    .filter(p => p.is_enabled)
    .map(p => {
      const tags = (p.tags || []).map(t => t.toLowerCase().trim());
      const cats = tags.filter(t => t.startsWith('cat:')).map(t => t.slice(4));

      // Global stripe URL (applies to all sizes if no size-specific ones)
      const globalStripeTag = tags.find(t => t.startsWith('stripe:') && !t.match(/^stripe_\w+:/));
      const globalStripe = globalStripeTag ? globalStripeTag.slice(7) : null;

      // Size-specific stripe URLs: tag format  stripe_xl:https://...
      const sizeStripeMap = {};
      tags.filter(t => /^stripe_\w+:/.test(t)).forEach(t => {
        const colon = t.indexOf(':');
        const sizeKey = t.slice(0, colon).replace('stripe_', '').toUpperCase();
        sizeStripeMap[sizeKey] = t.slice(colon + 1);
      });

      // Build per-size variants (deduplicated)
      const enabled = p.variants.filter(v => v.is_enabled);
      const seenSizes = new Set();
      const variants = [];
      enabled.forEach(v => {
        const size = extractSize(v.title);
        if (!seenSizes.has(size)) {
          seenSizes.add(size);
          variants.push({
            size,
            price: (v.price / 100).toFixed(2),
            stripeUrl: sizeStripeMap[size] || globalStripe,
          });
        }
      });

      const prices = variants.map(v => parseFloat(v.price));
      const minPrice = prices.length ? Math.min(...prices) : 0;
      const sizes = variants.map(v => v.size);

      // Up to 4 product images
      const images = p.images.slice(0, 4).map(img => img.src);
      const defaultImg = p.images.find(img => img.is_default) || p.images[0];

      return {
        id: p.id,
        title: p.title,
        description: (p.description || '').replace(/<[^>]*>/g, '').trim().slice(0, 200),
        image: defaultImg ? defaultImg.src : null,
        images,
        categories: cats.length ? cats : ['tech'],
        stripeUrl: globalStripe || (variants[0] && variants[0].stripeUrl) || null,
        variants,
        sizes,
        price: minPrice.toFixed(2),
        isNew: tags.includes('new'),
        isBestSeller: tags.includes('bestseller'),
      };
    });

  const outPath = path.join(__dirname, '..', 'products.json');
  fs.writeFileSync(outPath, JSON.stringify(products, null, 2));
  console.log(`Synced ${products.length} products → products.json`);
}

main().catch(err => { console.error(err); process.exit(1); });
