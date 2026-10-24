export function reportAsyncFailure(scope = "ui") {
  const label = String(scope || "ui").trim() || "ui";
  return (error) => {
    console.error(`[lpc:${label}] unexpected asynchronous failure`, error);
  };
}
