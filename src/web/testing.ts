import { chromium, type Browser, type Page } from "playwright";

export type ViewerAssets = Map<string, { contentType: string; body: string }>;

export async function launchViewerBrowser(): Promise<Browser> {
  Bun.gc(true);
  return chromium.launch({ headless: true });
}

export async function closeViewerBrowser(browser: Browser | undefined): Promise<void> {
  await browser?.close();
  Bun.gc(true);
}

export async function textContrast(page: Page, selector: string): Promise<number> {
  return page.locator(selector).first().evaluate((element) => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d")!;
    const rgba = (color: string) => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      return Array.from(context.getImageData(0, 0, 1, 1).data, (value) => value / 255);
    };
    const blend = (color: number[], background: number[]) => color.slice(0, 3).map((value, index) => value * color[3]! + background[index]! * (1 - color[3]!));
    const ancestors: Element[] = [];
    for (let current: Element | null = element; current; current = current.parentElement) ancestors.unshift(current);
    let background = [1, 1, 1];
    for (const ancestor of ancestors) background = blend(rgba(getComputedStyle(ancestor).backgroundColor), background);
    const foreground = blend(rgba(getComputedStyle(element).color), background);
    const luminance = (color: number[]) => color.map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
      .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index]!, 0);
    const light = luminance(foreground);
    const dark = luminance(background);
    return (Math.max(light, dark) + 0.05) / (Math.min(light, dark) + 0.05);
  });
}

export async function buildViewerAssets(): Promise<ViewerAssets> {
  const base = new URL("./", import.meta.url);
  const assets: ViewerAssets = new Map();
  const build = await Bun.build({
    entrypoints: ["app.ts", "city-builders.ts", "styles.css"].map((path) => new URL(path, base).pathname),
    target: "browser",
    minify: true,
    naming: "[name].[ext]",
  });
  if (!build.success) throw new Error(`Viewer build failed: ${build.logs.join("\n")}`);
  for (const output of build.outputs) {
    assets.set(`/${output.path.split("/").at(-1)}`, {
      contentType: output.path.endsWith(".css") ? "text/css" : "application/javascript",
      body: await output.text(),
    });
  }
  for (const file of ["index.html", "city-builders.html"]) {
    const asset = { contentType: "text/html", body: await Bun.file(new URL(file, base)).text() };
    assets.set(`/${file}`, asset);
    assets.set(file === "index.html" ? "/" : "/city-builders", asset);
  }
  assets.set("/vendor/0build/0.6.13/kit.min.css", {
    contentType: "text/css",
    body: await Bun.file(new URL("vendor/0build/0.6.13/kit.min.css", base)).text(),
  });
  return assets;
}
