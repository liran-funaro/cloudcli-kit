// Sends only the server's hostname through the SSH SOCKS proxy; every other
// site stays DIRECT. client/install.sh writes the real hostname and port into
// the copy it installs; this file keeps the placeholders.
const proxyConfig = {
  mode: "pac_script",
  pacScript: {
    data: `function FindProxyForURL(url, host) {
      if (host.toLowerCase() === "devbox.example.com") {
        return "SOCKS5 127.0.0.1:1080";
      }
      return "DIRECT";
    }`,
    mandatory: true,
  },
};

function enableProxy() {
  chrome.proxy.settings.set(
    { value: proxyConfig, scope: "regular" },
    () => {
      if (chrome.runtime.lastError) {
        console.error(chrome.runtime.lastError.message);
        return;
      }

      chrome.storage.local.set({ enabled: true });
      chrome.action.setBadgeText({ text: "ON" });
      chrome.action.setBadgeBackgroundColor({ color: "#2e7d32" });
      chrome.action.setTitle({ title: "CloudCLI SSH Proxy: enabled" });
    },
  );
}

function disableProxy() {
  chrome.proxy.settings.clear({ scope: "regular" }, () => {
    if (chrome.runtime.lastError) {
      console.error(chrome.runtime.lastError.message);
      return;
    }

    chrome.storage.local.set({ enabled: false });
    chrome.action.setBadgeText({ text: "" });
    chrome.action.setTitle({ title: "CloudCLI SSH Proxy: disabled" });
  });
}

chrome.runtime.onInstalled.addListener(enableProxy);
chrome.runtime.onStartup.addListener(() => {
  chrome.storage.local.get({ enabled: true }, ({ enabled }) => {
    if (enabled) {
      enableProxy();
    }
  });
});

chrome.action.onClicked.addListener(() => {
  chrome.storage.local.get({ enabled: true }, ({ enabled }) => {
    if (enabled) {
      disableProxy();
    } else {
      enableProxy();
    }
  });
});
