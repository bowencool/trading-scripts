import { OAuth, Config } from "longbridge";

export async function buildConfig(clientId: string): Promise<Config> {
  const oauth = await OAuth.build(clientId, (_err, url) => {
    console.log("\n请在浏览器中打开以下链接完成授权：");
    console.log(url);
    console.log("");
  });
  return Config.fromOAuth(oauth);
}
