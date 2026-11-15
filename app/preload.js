const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("nova", {
  onState: (fn) => ipcRenderer.on("state", (_e, s) => fn(s)),
  onConfig: (fn) => ipcRenderer.on("config", (_e, c) => fn(c)),
  ready: () => ipcRenderer.send("ready"),
  set: (key, value) => ipcRenderer.send("set", { key, value }),
  openHeads: () => ipcRenderer.send("openHeads"),
  win: (what) => ipcRenderer.send("win", what),
});
