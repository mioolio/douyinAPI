const fs = require('fs');

const file = 'D:/Desktop/DYCC/SPRR/data/capture/js/e445bc994f58___federation_expose_default_export.d40e64ca.js';
const c = fs.readFileSync(file, 'utf8');

// Helper: print snippet around offset
function snippet(offset, before, after, label) {
  const start = Math.max(0, offset - before);
  const end = Math.min(c.length, offset + after);
  console.log(`\n=== ${label} (offset=${offset}, range=${start}..${end}) ===`);
  console.log(c.slice(start, end));
}

// 1. The nT function with url/oid/skey/size - likely image decryption
snippet(274372, 400, 1200, 'nT: url+oid+skey+size decrypt');

// 2. The nN function with large_url_list, origin_url_list, skey, oid - URL builder
snippet(275177, 100, 500, 'nN: large_url_list/origin_url_list/skey/oid');

// 3. show_once_info handling (at offset 383168)
snippet(383168, 600, 800, 'show_once_info handler');

// 4. read_once/has_read API (at offset 152371)
snippet(152371, 200, 500, 'read_once/has_read');

// 5. batch_build_image call (at offset 270441)
snippet(270441, 200, 500, 'batch_build_image call');

// 6. AES-GCM crypto setup (at offset 142533)
snippet(142533, 300, 500, 'AES-GCM crypto setup');

// 7. cipher algorithm switch (at offset 328919)
snippet(328919, 200, 800, 'cipher algorithm switch');

// 8. aes-256-gcm-chunks (at offset 328004)
snippet(328004, 100, 400, 'aes-256-gcm-chunks (importKey)');
