import { chromium } from "playwright";

const source = await Bun.file(new URL("../src/web/logo.svg", import.meta.url)).text();
const sizes = [16, 32, 48];
const images: Buffer[] = [];
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  for (const size of sizes) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<style>body{margin:0}svg{display:block;width:100vw;height:100vh;fill:#059669}</style>${source}`);
    images.push(await page.screenshot({ type: "png", omitBackground: true }));
  }
} finally {
  await browser.close();
}

const directory = Buffer.alloc(6 + sizes.length * 16);
directory.writeUInt16LE(1, 2);
directory.writeUInt16LE(sizes.length, 4);
let offset = directory.length;
for (const [index, size] of sizes.entries()) {
  const entry = 6 + index * 16;
  const image = images[index]!;
  directory[entry] = size;
  directory[entry + 1] = size;
  directory.writeUInt16LE(1, entry + 4);
  directory.writeUInt16LE(32, entry + 6);
  directory.writeUInt32LE(image.length, entry + 8);
  directory.writeUInt32LE(offset, entry + 12);
  offset += image.length;
}
await Bun.write(new URL("../src/web/favicon.ico", import.meta.url), Buffer.concat([directory, ...images]));
