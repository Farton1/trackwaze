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
      const stripeTag = tags.find(t => t.startsWith('stripe:'));
      const cats = tags.filter(t => t.startsWith('cat:')).map(t => t.slice(4));
      const enabled = p.variants.filter(v => v.is_enabled);
      const sizes = [...new Set(enabled.map(v => extractSize(v.title)))];
      const minPrice = enabled.length ? Math.min(...enabled.map(v => v.price)) : 0;
      const defaultImg = p.images.find(img => img.is_default) || p.images[0];
      return {
        id: p.id,
        title: p.title,
        description: (p.description || '').replace(/<[^>]*>/g, '').trim().slice(0, 120),
        image: defaultImg ? defaultImg.src : null,
        categories: cats.length ? cats : ['tech'],
        stripeUrl: stripeTag ? stripeTag.slice(7) : null,
        sizes,
        price: (minPrice / 100).toFixed(2),
        isNew: tags.includes('new'),
        isBestSeller: tags.includes('bestseller'),
      };
    });

  const outPath = path.join(__dirname, '..', 'products.json');
  fs.writeFileSync(outPath, JSON.stringify(products, null, 2));
  console.log(`Synced ${products.length} products → products.json`);
}

main().catch(err => { console.error(err); process.exit(1); });
