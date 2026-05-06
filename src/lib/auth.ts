import { Config, OAuth } from "longbridge";

export async function buildConfig(clientId: string): Promise<Config> {
  const oauth = await OAuth.build(clientId, (err, url) => {
    if (err) {
      console.error("OAuth 错误:", err);
      return;
    }
    console.log("\n请在浏览器中打开以下链接完成授权：");
    console.log(url);
    console.log("");
  });
  return Config.fromOAuth(oauth, { enablePrintQuotePackages: false });
}
