"use strict";
const Module = require("module");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const https = require("https");
const realChildProcess = require("child_process");
const crypto = require("crypto");
const { EventEmitter } = require("events");

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const appRoot = path.resolve(process.argv[2] || path.join(__dirname, ".."));
if (!fs.existsSync(path.join(appRoot, "index.js"))) {
  console.error("usage: node scripts/test-containment.cjs [app root containing index.js]");
  process.exit(2);
}

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "contain-"));
const userDataDir = path.join(workDir, "userdata");
const dlDir = path.join(workDir, "dl");
const dataDir = path.join(workDir, "data");
for (const dir of [userDataDir, dlDir, dataDir]) fs.mkdirSync(dir, { recursive: true });

const moviePath = path.join(dlDir, "movie.mp4");
const okMediaPath = path.join(dataDir, "ok.mp4");
const secretPath = path.join(dataDir, "secret.txt");
fs.writeFileSync(moviePath, "video");
fs.writeFileSync(okMediaPath, "video");
fs.writeFileSync(secretPath, "topsecret");
fs.writeFileSync(
  path.join(userDataDir, "downloads.json"),
  JSON.stringify([
    {
      id: "d1",
      name: "Movie",
      filePath: moviePath,
      downloadPath: dlDir,
      status: "completed",
      tmdbId: 1,
      mediaType: "movie",
      subtitlePaths: [],
    },
  ]),
);

const results = [];
const record = (name, passed, detail = "") => results.push({ name, passed, detail });

const childProcessCalls = { spawn: [], spawnSync: [] };
const childProcessState = { whichStatus: 1 };
const childProcessStub = {
  spawn: (...args) => {
    childProcessCalls.spawn.push(args);
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = () => {};
    proc.unref = () => {};
    return proc;
  },
  spawnSync: (...args) => {
    childProcessCalls.spawnSync.push(args);
    const status = args[0] === "which" ? childProcessState.whichStatus : 1;
    return { status, stdout: "", stderr: "" };
  },
  execFile: () => {
    throw new Error("execFile not expected");
  },
};

const sessions = new Map();
function getSession(name) {
  if (sessions.has(name)) return sessions.get(name);
  const fakeSession = new EventEmitter();
  fakeSession.partitionName = name;
  fakeSession.permissionRequestHandler = null;
  fakeSession.permissionCheckHandler = null;
  fakeSession.webRequest = { onHeadersReceived() {}, onBeforeRequest() {} };
  fakeSession.setUserAgent = () => {};
  fakeSession.setPermissionRequestHandler = (handler) => {
    fakeSession.permissionRequestHandler = handler;
  };
  fakeSession.setPermissionCheckHandler = (handler) => {
    fakeSession.permissionCheckHandler = handler;
  };
  fakeSession.cookies = { set: () => Promise.resolve() };
  fakeSession.clearCache = () => Promise.resolve();
  fakeSession.clearStorageData = () => Promise.resolve();
  fakeSession.getCacheSize = () => Promise.resolve(0);
  sessions.set(name, fakeSession);
  return fakeSession;
}

let webContentsCounter = 0;
class FakeWebContents extends EventEmitter {
  constructor(session) {
    super();
    this.session = session;
    this.id = ++webContentsCounter;
    this.sent = [];
  }
  setWindowOpenHandler(handler) {
    this.windowOpenHandler = handler;
  }
  send(...args) {
    this.sent.push(args);
  }
  executeJavaScript() {
    return Promise.resolve();
  }
  isDestroyed() {
    return false;
  }
  loadFile() {}
  loadURL() {}
  setAudioMuted() {}
  destroy() {}
}

const windows = [];
class FakeBrowserWindow extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    const partition = options.webPreferences?.partition ?? "default";
    this.webContents = new FakeWebContents(getSession(partition));
    windows.push(this);
  }
  loadFile() {}
  loadURL(url) {
    this.loadedUrl = url;
  }
  focus() {}
  minimize() {}
  maximize() {}
  unmaximize() {}
  restore() {}
  close() {}
  destroy() {}
  isDestroyed() {
    return false;
  }
  isMaximized() {
    return false;
  }
  isMinimized() {
    return false;
  }
}

const ipcHandlers = new Map();
const ipcListeners = new Map();
const appExitCalls = [];
const electronStub = {
  app: {
    commandLine: { appendSwitch() {} },
    requestSingleInstanceLock: () => true,
    on() {},
    whenReady: () => Promise.resolve(),
    getPath: () => userDataDir,
    getVersion: () => "0.0.0",
    getAppPath: () => appRoot,
    isPackaged: false,
    quit() {},
    exit: (code) => appExitCalls.push(code),
    relaunch() {},
  },
  ipcMain: {
    handle: (channel, handler) => ipcHandlers.set(channel, handler),
    on: (channel, handler) => ipcListeners.set(channel, handler),
  },
  BrowserWindow: FakeBrowserWindow,
  session: {
    fromPartition: getSession,
    get defaultSession() {
      return getSession("default");
    },
  },
  webContents: { fromId: () => null, getAllWebContents: () => [] },
  Notification: class {
    static isSupported() {
      return false;
    }
  },
  safeStorage: { isEncryptionAvailable: () => false },
  dialog: { showOpenDialog: async () => ({ canceled: true }) },
  shell: { openPath() {}, openExternal() {}, showItemInFolder() {} },
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "electron") return electronStub;
  if (request === "child_process") return childProcessStub;
  return originalLoad.apply(this, arguments);
};

function loadWithInternals(filePath, names) {
  const source = `${fs.readFileSync(filePath, "utf8")}\nmodule.exports.__internals = { ${names.join(", ")} };\n`;
  const loaded = new Module(filePath, module);
  loaded.filename = filePath;
  loaded.paths = Module._nodeModulePaths(path.dirname(filePath));
  loaded._compile(source, filePath);
  return loaded.exports.__internals;
}

const makeEvent = () => ({
  prevented: false,
  preventDefault() {
    this.prevented = true;
  },
});
const emitAndCheckPrevented = (emitter, eventName, url) => {
  const event = makeEvent();
  emitter.emit(eventName, event, url);
  return event.prevented;
};
const tick = () => new Promise((resolve) => setImmediate(resolve));
const withTimeout = (promise, ms, fallback) =>
  Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(fallback), ms))]);

const certPath = path.join(workDir, "cert.pem");
const keyPath = path.join(workDir, "key.pem");
let tlsAvailable = true;
try {
  realChildProcess.execFileSync(
    "openssl",
    ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyPath, "-out", certPath, "-days", "1", "-subj", "/CN=127.0.0.1"],
    { stdio: "ignore" },
  );
} catch {
  tlsAvailable = false;
}

const SRT = "1\n00:00:01,000 --> 00:00:02,000\nhello\n";
const BIG = 11 * 1024 * 1024;
const httpLog = [];
const httpsLog = [];

function subtitleHandler(log) {
  return (req, res) => {
    log.push(req.url);
    if (req.url === "/small.srt") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(SRT);
      return;
    }
    if (req.url === "/big.srt") {
      res.writeHead(200, { "content-type": "text/plain", "content-length": String(BIG) });
      res.end(Buffer.alloc(BIG, 97));
      return;
    }
    if (req.url === "/stream.srt") {
      res.writeHead(200, { "content-type": "text/plain" });
      const chunk = Buffer.alloc(1024 * 1024, 97);
      let sent = 0;
      const pump = () => {
        while (sent < BIG) {
          sent += chunk.length;
          if (!res.write(chunk)) {
            res.once("drain", pump);
            return;
          }
        }
        res.end();
      };
      pump();
      return;
    }
    if (req.url === "/loop") {
      res.writeHead(302, { location: "/loop" });
      res.end();
      return;
    }
    res.writeHead(404);
    res.end();
  };
}

const httpServer = http.createServer(subtitleHandler(httpLog));
const httpsServer = tlsAvailable
  ? https.createServer({ key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) }, subtitleHandler(httpsLog))
  : null;

const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));

async function main() {
  const httpPort = await listen(httpServer);
  const httpsPort = httpsServer ? await listen(httpsServer) : 0;

  require(path.join(appRoot, "index.js"));
  await tick();
  await tick();

  const mainWindow = windows[0];
  const attachHandler = mainWindow.webContents.listeners("will-attach-webview")[0];
  const didAttachHandler = mainWindow.webContents.listeners("did-attach-webview")[0];

  const webPreferences = {
    preload: "/x",
    nodeIntegration: true,
    contextIsolation: false,
    sandbox: false,
    webSecurity: false,
    allowRunningInsecureContent: true,
    nodeIntegrationInSubFrames: true,
  };
  const attachEvent = makeEvent();
  attachHandler(attachEvent, webPreferences, { partition: "player", src: "https://vidsrc.sh/x" });
  record("webview: preload removed", webPreferences.preload === undefined);
  record("webview: nodeIntegration forced off", webPreferences.nodeIntegration === false);
  record("webview: contextIsolation forced on", webPreferences.contextIsolation === true);
  record("webview: sandbox forced on", webPreferences.sandbox === true);
  record("webview: webSecurity forced on", webPreferences.webSecurity === true);
  record("webview: insecure content forced off", webPreferences.allowRunningInsecureContent === false);
  record("webview: node in subframes forced off", webPreferences.nodeIntegrationInSubFrames === false);
  record("webview: allowed partition not blocked", attachEvent.prevented === false);
  const evilEvent = makeEvent();
  attachHandler(evilEvent, { ...webPreferences }, { partition: "persist:evil", src: "https://x" });
  record("webview: unknown partition blocked", evilEvent.prevented === true);

  const playerGuest = new FakeWebContents(getSession("player"));
  didAttachHandler({}, playerGuest);
  const trailerGuest = new FakeWebContents(getSession("persist:trailer"));
  didAttachHandler({}, trailerGuest);

  const redirectCases = [
    ["player redirect to allowed host", "https://vidsrc.sh/embed/movie/1", false],
    ["player redirect to other host", "https://evil.example/", true],
    ["player redirect to http", "http://vidsrc.sh/", true],
    ["player redirect to javascript:", "javascript:alert(1)", true],
    ["player redirect to file:", "file:///etc/passwd", true],
  ];
  for (const [label, url, shouldBlock] of redirectCases) {
    record(label, emitAndCheckPrevented(playerGuest, "will-redirect", url) === shouldBlock);
  }
  record("trailer redirect to https host allowed", emitAndCheckPrevented(trailerGuest, "will-redirect", "https://inv.example/embed/abc") === false);
  record("trailer redirect to http blocked", emitAndCheckPrevented(trailerGuest, "will-redirect", "http://inv.example/embed/abc") === true);
  record("trailer redirect to file: blocked", emitAndCheckPrevented(trailerGuest, "will-redirect", "file:///etc/passwd") === true);

  const trailerSession = getSession("persist:trailer");
  let trailerPermissionDenied = false;
  if (trailerSession.permissionRequestHandler) {
    trailerSession.permissionRequestHandler(null, "media", (granted) => {
      trailerPermissionDenied = granted === false;
    });
  }
  record("trailer session: permissions denied", trailerPermissionDenied);
  record("trailer session: permission check denies", trailerSession.permissionCheckHandler ? trailerSession.permissionCheckHandler() === false : false);
  const downloadEvent = makeEvent();
  trailerSession.emit("will-download", downloadEvent);
  record("trailer session: downloads blocked", downloadEvent.prevented === true);

  await ipcHandlers.get("open-pip-window")({}, { url: "https://vidsrc.sh/embed/movie/550", title: "t" });
  const pipWindow = windows[windows.length - 1];
  record("pip: redirect to other host blocked", emitAndCheckPrevented(pipWindow.webContents, "will-redirect", "https://evil.example/") === true);
  record("pip: redirect to allowed host allowed", emitAndCheckPrevented(pipWindow.webContents, "will-redirect", "https://vidsrc.sh/embed/movie/550") === false);

  const durationHandler = ipcHandlers.get("get-video-duration");
  const durationCases = [
    ["duration: option-like path never reaches ffprobe", "-version", 0],
    ["duration: url never reaches ffprobe", "http://127.0.0.1:1/x.mp4", 0],
    ["duration: non-media file never reaches ffprobe", secretPath, 0],
  ];
  for (const [label, filePath, expectedCalls] of durationCases) {
    const before = childProcessCalls.spawnSync.length;
    await durationHandler({}, filePath);
    record(label, childProcessCalls.spawnSync.length - before === expectedCalls);
  }
  const beforeValid = childProcessCalls.spawnSync.length;
  await durationHandler({}, okMediaPath);
  record("duration: real media file still probed", childProcessCalls.spawnSync.length - beforeValid > 0);

  record("debug-allmanga handler removed", !ipcHandlers.has("debug-allmanga"));
  record("preload no longer exposes debugAllManga", !fs.readFileSync(path.join(appRoot, "preload.js"), "utf8").includes("debugAllManga"));

  const updateHandler = ipcHandlers.get("download-and-install-update");
  const makeResponse = ({ statusCode = 200, headers = {}, body = Buffer.alloc(0) }) => {
    const res = new EventEmitter();
    res.statusCode = statusCode;
    res.headers = headers;
    res.resume = () => {};
    res.destroy = () => {};
    res.setEncoding = () => {};
    res.emitBody = () => {
      if (body.length) res.emit("data", body);
      res.emit("end");
    };
    return res;
  };
  const realHttpsGet = https.get;
  const releaseApiPrefix = "https://api.github.com/repos/Ali-Zadeh/streambert/releases/tags/";
  const assetRequests = [];
  const stubUpdateResponse = (assetResponse, releaseJson) => {
    https.get = (url, options, callback) => {
      const req = new EventEmitter();
      req.destroy = () => {};
      req.setTimeout = (ms, onTimeout) => {
        req.onTimeout = onTimeout;
      };
      setImmediate(() => {
        let res;
        if (releaseJson === "hang" && String(url).startsWith(releaseApiPrefix)) {
          req.onTimeout();
          return;
        }
        if (String(url).startsWith(releaseApiPrefix)) {
          res =
            releaseJson === null
              ? makeResponse({ statusCode: 404 })
              : makeResponse({ body: Buffer.from(JSON.stringify(releaseJson)) });
        } else {
          assetRequests.push(String(url));
          res = makeResponse(assetResponse);
        }
        callback(res);
        setImmediate(() => res.emitBody());
      });
      return req;
    };
  };
  const updateUrl = "https://github.com/Ali-Zadeh/streambert/releases/download/v9.9.9/Streambert-Setup.exe";
  const sha256Of = (text) => crypto.createHash("sha256").update(text).digest("hex");
  const releaseWith = (asset) => ({ assets: asset === null ? [] : [{ name: "Streambert-Setup.exe", browser_download_url: updateUrl, ...asset }] });
  const helloAsset = { headers: { "content-length": "5" }, body: Buffer.from("hello") };
  const updateTempDirs = () => fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith("streambert-update-"));
  const spawnsBeforeUpdate = childProcessCalls.spawn.length;
  stubUpdateResponse(helloAsset, releaseWith({ digest: `sha256:${sha256Of("hello")}` }));
  const updateResult = await updateHandler({}, { url: updateUrl, format: "exe" });
  const installerCall = childProcessCalls.spawn[childProcessCalls.spawn.length - 1];
  const installerPath = childProcessCalls.spawn.length > spawnsBeforeUpdate ? installerCall[0] : null;
  record("update: small valid download installs", updateResult.ok === true && installerPath !== null);
  if (installerPath) {
    const installerDir = path.dirname(installerPath);
    record("update: installer is not directly in the shared temp dir", installerDir !== os.tmpdir());
    record("update: installer dir is private (0700)", (fs.statSync(installerDir).mode & 0o777) === 0o700);
    record("update: installer content intact", fs.readFileSync(installerPath, "utf8") === "hello");
    fs.rmSync(installerPath, { force: true });
  }
  fs.rmSync(path.join(os.tmpdir(), "streambert-update.exe"), { force: true });

  const spawnsBeforeOversize = childProcessCalls.spawn.length;
  stubUpdateResponse(
    { headers: { "content-length": String(2 * 1024 * 1024 * 1024) }, body: Buffer.from("hello") },
    releaseWith({ digest: `sha256:${sha256Of("hello")}` }),
  );
  const oversizeResult = await updateHandler({}, { url: updateUrl, format: "exe" });
  record("update: oversized download refused", oversizeResult.ok === false && childProcessCalls.spawn.length === spawnsBeforeOversize);
  fs.rmSync(path.join(os.tmpdir(), "streambert-update.exe"), { force: true });

  const refusalCases = [
    ["update: wrong SHA-256 refused", releaseWith({ digest: `sha256:${"0".repeat(64)}` }), true],
    ["update: release without digest refused before download", releaseWith({}), false],
    ["update: asset missing from release refused before download", releaseWith(null), false],
    ["update: failed release lookup refused before download", null, false],
    ["update: hung release lookup times out before download", "hang", false],
  ];
  for (const [label, releaseJson, downloadExpected] of refusalCases) {
    const spawnsBefore = childProcessCalls.spawn.length;
    const assetRequestsBefore = assetRequests.length;
    const dirsBefore = new Set(updateTempDirs());
    stubUpdateResponse(helloAsset, releaseJson);
    const refusal = await updateHandler({}, { url: updateUrl, format: "exe" });
    const leftoverInstallers = updateTempDirs()
      .filter((name) => !dirsBefore.has(name))
      .filter((name) => fs.existsSync(path.join(os.tmpdir(), name, "streambert-update.exe")));
    const downloaded = assetRequests.length > assetRequestsBefore;
    const refused = refusal.ok === false && childProcessCalls.spawn.length === spawnsBefore;
    record(label, refused && downloaded === downloadExpected && leftoverInstallers.length === 0);
    fs.rmSync(path.join(os.tmpdir(), "streambert-update.exe"), { force: true });
  }
  https.get = realHttpsGet;

  const subtitleHandlerFn = ipcHandlers.get("download-subtitles-for-file");
  const targetSubtitle = path.join(dlDir, "movie.en.srt");
  const downloadSubtitle = async (directUrl) => {
    fs.rmSync(targetSubtitle, { force: true });
    await subtitleHandlerFn({}, {
      filePath: moviePath,
      selectedSubs: [{ file_id: "wyzie_0_x", direct_url: directUrl, language: "en" }],
    });
    const written = fs.existsSync(targetSubtitle);
    fs.rmSync(targetSubtitle, { force: true });
    return written;
  };

  const httpHitsBefore = httpLog.length;
  const httpWritten = await downloadSubtitle(`http://127.0.0.1:${httpPort}/small.srt`);
  record("subtitles: plain http url refused", httpWritten === false && httpLog.length === httpHitsBefore);

  if (tlsAvailable) {
    record("subtitles: oversized (content-length) refused", (await downloadSubtitle(`https://127.0.0.1:${httpsPort}/big.srt`)) === false);
    record("subtitles: oversized (streamed) refused", (await downloadSubtitle(`https://127.0.0.1:${httpsPort}/stream.srt`)) === false);
    record("subtitles: small https subtitle still saved", (await downloadSubtitle(`https://127.0.0.1:${httpsPort}/small.srt`)) === true);

  } else {
    record("subtitles: https cases skipped (openssl unavailable)", false, "SKIPPED");
  }

  const realFetch = globalThis.fetch;
  const fetchLog = [];
  globalThis.fetch = async (url) => {
    fetchLog.push(String(url));
    return new Response("nope", { status: 404 });
  };
  const hostTrickId = `subdl_1_${encodeURIComponent(".evil.example/x.zip")}`;
  await subtitleHandlerFn({}, { filePath: moviePath, selectedSubs: [{ file_id: hostTrickId, language: "en" }] });
  await ipcHandlers.get("get-subtitle-url")({}, { fileId: hostTrickId });
  record("subtitles: subdl id cannot extend the host (.evil.example)", fetchLog.every((fetched) => new URL(fetched).hostname === "dl.subdl.com"));
  const fetchCountBeforeValid = fetchLog.length;
  await ipcHandlers.get("get-subtitle-url")({}, { fileId: `subdl_1_${encodeURIComponent("/subtitle/1-2.zip")}` });
  record("subtitles: valid subdl id still fetched from dl.subdl.com", fetchLog.slice(fetchCountBeforeValid).includes("https://dl.subdl.com/subtitle/1-2.zip"));
  globalThis.fetch = realFetch;

  const downloadsInternals = loadWithInternals(path.join(appRoot, "src/ipc/downloads.js"), ["downloadSubtitleFile"]);
  const downloadSubtitleFile = (url, destPath) =>
    downloadsInternals.downloadSubtitleFile.length === 1
      ? downloadsInternals.downloadSubtitleFile({ url, destPath })
      : downloadsInternals.downloadSubtitleFile(url, destPath);
  const copyTarget = path.join(workDir, "copied.srt");

  fs.rmSync(copyTarget, { force: true });
  const outsideCopyOk = await downloadSubtitleFile(`file://${secretPath}`, copyTarget);
  record("downloads: file: copy outside temp subtitles refused", outsideCopyOk === false && !fs.existsSync(copyTarget));

  const tempSubtitle = path.join(os.tmpdir(), "streambert_sub_harness_x.srt");
  fs.writeFileSync(tempSubtitle, SRT);
  fs.rmSync(copyTarget, { force: true });
  const tempCopyOk = await downloadSubtitleFile(`file://${tempSubtitle}`, copyTarget);
  record("downloads: file: copy of own temp subtitle still works", tempCopyOk === true && fs.existsSync(copyTarget));
  fs.rmSync(tempSubtitle, { force: true });

  fs.rmSync(copyTarget, { force: true });
  record("downloads: plain http subtitle still works", (await downloadSubtitleFile(`http://127.0.0.1:${httpPort}/small.srt`, copyTarget)) === true);

  if (tlsAvailable) {
    fs.rmSync(copyTarget, { force: true });
    const streamedOk = await withTimeout(downloadSubtitleFile(`https://127.0.0.1:${httpsPort}/stream.srt`, copyTarget), 8000, "timeout");
    record("downloads: oversized streamed subtitle refused and removed", streamedOk === false && !fs.existsSync(copyTarget));
    fs.rmSync(copyTarget, { force: true });
    const loopOk = await withTimeout(downloadSubtitleFile(`https://127.0.0.1:${httpsPort}/loop`, copyTarget), 4000, "timeout");
    record("downloads: redirect loop stops", loopOk === false);
  }
  fs.rmSync(copyTarget, { force: true });

  const setVideo = ipcHandlers.get("set-player-video");
  const { playerUrl } = await setVideo({}, { url: "https://example.com/video.mp4", referer: "https://allmanga.to", startTime: 0 });
  const playerPort = new URL(playerUrl).port;
  const requestWithHost = (hostHeader) =>
    new Promise((resolve) => {
      const req = http.get({ hostname: "127.0.0.1", port: playerPort, path: "/player", headers: { Host: hostHeader } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on("error", () => resolve(0));
    });
  record("player server: foreign Host header refused", (await requestWithHost("evil.example")) === 403);
  record("player server: 127.0.0.1 Host accepted", (await requestWithHost(`127.0.0.1:${playerPort}`)) === 200);
  record("player server: localhost Host accepted", (await requestWithHost(`localhost:${playerPort}`)) === 200);

  const allmanga = loadWithInternals(path.join(appRoot, "src/ipc/allmanga.js"), ["trySourceUrls", "decodeAllanimeUrl", "ALLANIME_HEX_MAP"]);
  const reverseMap = {};
  for (const [pair, char] of Object.entries(allmanga.ALLANIME_HEX_MAP)) reverseMap[char] = pair;
  const encode = (plain) => `--${[...plain].map((char) => reverseMap[char]).join("")}`;
  const sampleUrl = "https://evil.example/watch?next=youtube.com/watch";
  record("yt-dlp test: encoder round-trips", allmanga.decodeAllanimeUrl(encode(sampleUrl)) === sampleUrl);

  const realHttpsRequest = https.request;
  https.request = (options, callback) => {
    const req = new EventEmitter();
    req.setTimeout = () => {};
    req.destroy = () => {};
    req.write = () => {};
    req.end = () => {
      const res = new EventEmitter();
      res.statusCode = 200;
      res.headers = {};
      res.resume = () => {};
      setImmediate(() => callback(res));
    };
    return req;
  };
  childProcessState.whichStatus = 0;
  const ytdlpCallsFor = async (url) => {
    const before = childProcessCalls.spawnSync.length;
    await allmanga.trySourceUrls([{ sourceUrl: encode(url), sourceName: "Yt-mp4", priority: 1 }]);
    return childProcessCalls.spawnSync.slice(before).filter((call) => call[0] === "yt-dlp").length;
  };
  record("yt-dlp: not run for a non-YouTube host that mentions youtube.com/watch", (await ytdlpCallsFor("https://evil.example/watch?next=youtube.com/watch")) === 0);
  record("yt-dlp: not run for a non-YouTube host with youtube.com/watch in its path", (await ytdlpCallsFor("https://evil.example/youtube.com/watch?v=abc")) === 0);
  record("yt-dlp: still run for youtube.com watch page", (await ytdlpCallsFor("https://www.youtube.com/watch?v=abc")) === 1);
  record("yt-dlp: still run for youtu.be link", (await ytdlpCallsFor("https://youtu.be/abc")) === 1);
  https.request = realHttpsRequest;
  childProcessState.whichStatus = 1;

  const downloaderRoot = fs.mkdtempSync(path.join(workDir, "downloader-"));
  const makeDownloaderFolder = (binaryName, mode) => {
    const folder = fs.mkdtempSync(path.join(downloaderRoot, "f-"));
    fs.mkdirSync(path.join(folder, "_internal"));
    fs.writeFileSync(path.join(folder, binaryName), "#!/bin/sh\n", { mode });
    return folder;
  };
  const checkDownloader = ipcHandlers.get("check-downloader");
  record("downloader: executable with another name refused", checkDownloader({}, makeDownloaderFolder("evil-tool", 0o755)).exists === false);
  const realDownloaderFolder = makeDownloaderFolder("vid-dl", 0o755);
  const realDownloader = checkDownloader({}, realDownloaderFolder);
  record("downloader: vid-dl binary accepted", realDownloader.exists === true && typeof realDownloader.token === "string");
  const spawnsBeforeDownload = childProcessCalls.spawn.length;
  ipcHandlers.get("run-download")({}, { token: realDownloader.token, m3u8Url: "https://example.com/a.m3u8", name: "x", downloadPath: dlDir, subtitles: [] });
  const downloadSpawn = childProcessCalls.spawn[childProcessCalls.spawn.length - 1];
  record("downloader: token launches the vid-dl path", childProcessCalls.spawn.length === spawnsBeforeDownload + 1 && downloadSpawn[0] === path.join(realDownloaderFolder, "vid-dl"));
  record("downloader: vid-dl without execute bit refused", checkDownloader({}, makeDownloaderFolder("vid-dl", 0o644)).exists === false);

  const { playerUrl: hlsPlayerUrl } = await setVideo({}, { url: "https://example.com/video.m3u8", referer: "https://allmanga.to", startTime: 0 });
  const hlsPort = new URL(hlsPlayerUrl).port;
  const fetchLocal = (pathName) =>
    new Promise((resolve) => {
      const req = http.get({ hostname: "127.0.0.1", port: hlsPort, path: pathName, headers: { Host: `127.0.0.1:${hlsPort}` } }, (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode, type: String(res.headers["content-type"]), body: Buffer.concat(chunks) }));
      });
      req.on("error", () => resolve({ status: 0, type: "", body: Buffer.alloc(0) }));
    });
  const hlsPage = (await fetchLocal("/player")).body.toString();
  record("hls: player page loads no third-party script", !hlsPage.includes("cdn.jsdelivr.net") && hlsPage.includes("hls.min.js"));
  record("hls: player page uses the local script", hlsPage.includes('<script src="/hls.min.js"></script>'));
  const hlsScript = await fetchLocal("/hls.min.js");
  record("hls: local script is served as javascript", hlsScript.status === 200 && /javascript/.test(hlsScript.type) && hlsScript.body.length > 100000);
  let recordedHlsSha = null;
  try {
    const provenanceText = fs.readFileSync(path.join(appRoot, "src/ipc/vendor/hls.js.source.txt"), "utf8");
    recordedHlsSha = (provenanceText.match(/hls\.min\.js sha256: ([0-9a-f]{64})/) || [])[1] || null;
  } catch {}
  record("hls: served script matches the recorded sha256", recordedHlsSha !== null && sha256Of(hlsScript.body) === recordedHlsSha);

  const failed = results.filter((entry) => !entry.passed);
  for (const entry of results) {
    console.log(`${entry.passed ? "PASS" : "FAIL"}  ${entry.name}${entry.detail ? ` (${entry.detail})` : ""}`);
  }
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed  [app root: ${appRoot}]`);
  fs.rmSync(workDir, { recursive: true, force: true });
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error("HARNESS ERROR", error);
  process.exit(2);
});
