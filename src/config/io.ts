export function loadConfig() {
  return {
    browser: {
      enabled: true,
      defaultProfile: "default",
      attachOnly: true,
      profiles: {
        default: {
          cdpPort: 9222,
          cdpUrl: "http://127.0.0.1:9222",
          attachOnly: true,
        },
      },
    },
  };
}
