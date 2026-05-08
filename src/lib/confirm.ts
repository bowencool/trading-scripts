export function promptConfirm(message: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    console.log(message);
    console.log("(非交互模式，自动确认)");
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    process.stdout.write(message);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");

    const onData = (key: string) => {
      if (key === "\r" || key === "\n" || key === "y" || key === "Y") {
        cleanup();
        process.stdout.write("y\n");
        resolve(true);
      } else if (key === "\x1B" || key === "n" || key === "N" || key === "q" || key === "Q") {
        cleanup();
        process.stdout.write("n\n");
        resolve(false);
      }
    };

    const cleanup = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.off("data", onData);
    };

    process.stdin.on("data", onData);
  });
}
