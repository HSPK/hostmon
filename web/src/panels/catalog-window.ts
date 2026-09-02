export function catalogWindowLabel(
  seconds: number,
  requestedSeconds: number,
  context: "charts" | "selection" = "charts",
): {text: string; title: string} {
  const effective = formatWindow(seconds);
  const capped = seconds < requestedSeconds;
  return {
    text: `Stats: ${effective}${capped ? " (max)" : ""}`,
    title: capped
      ? context === "charts"
        ? `Metric statistics are limited to ${effective}; charts use ${formatWindow(requestedSeconds)}.`
        : `Metric statistics are limited to ${effective}; selected window is ${formatWindow(requestedSeconds)}.`
      : `Metric statistics use the selected ${effective} window.`,
  };
}

function formatWindow(seconds: number): string {
  if (seconds >= 86400 && seconds % 86400 === 0) {
    return `${seconds / 86400}d`;
  }
  if (seconds >= 3600 && seconds % 3600 === 0) {
    return `${seconds / 3600}h`;
  }
  return `${seconds / 60}m`;
}
