import prompts from "prompts";

export function promptConfirm(message: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    console.log(message);
    console.log("(非交互模式，自动确认)");
    return Promise.resolve(true);
  }

  return prompts({
    type: "confirm",
    name: "confirmed",
    message: formatConfirmMessage(message),
    initial: true,
  }).then((response) => response.confirmed === true);
}

function formatConfirmMessage(message: string): string {
  return message.trim().replace(/\s*\(Enter 确认 \/ Esc 取消\):?$/, "");
}
