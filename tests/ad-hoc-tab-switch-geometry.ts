// Document-to-document tab switches must not move the frame or toolbar. Page
// counts deliberately differ to expose intrinsic-width changes.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assemblePdf, cmdId, runStandalone, tmpPath, writeAppdata } from "./util.ts";
import { ControlCommand, type ControlClient, type LayoutInfo, type LayoutRect } from "./control.ts";
import { sendCopyDataW, sleep } from "./winapi.ts";
import { killAndWait, launchControlled, sendCommandSync, waitForTitle } from "./win-automation.ts";

const kCopyDataDdeW = 0x44646557;

function makePdf(pageCount: number): string {
  const kids = Array.from({ length: pageCount }, (_, i) => `${i + 3} 0 R`).join(" ");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Count ${pageCount} /Kids [${kids}] >>`,
    ...Array.from({ length: pageCount }, () => "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>"),
  ];
  return assemblePdf(objects);
}

function item(layout: LayoutInfo, name: string): LayoutRect {
  const value = layout.items[name];
  if (!value) {
    throw new Error(`tab-switch-geometry: missing '${name}' in:\n${layout.raw}`);
  }
  return value.rect;
}

function pageCount(layout: LayoutInfo): number {
  const count = pageCountOrUnknown(layout);
  if (count >= 0) {
    return count;
  }
  throw new Error(`tab-switch-geometry: page count missing in:\n${layout.raw}`);
}

function pageCountOrUnknown(layout: LayoutInfo): number {
  const match = /pages count=(\d+)/.exec(layout.raw);
  if (!match) {
    return -1;
  }
  return Number(match[1]);
}

type TabGeometry = {
  selected: boolean;
  rect: LayoutRect;
};

type TabsGeometry = {
  count: number;
  selected: number;
  tabWidth: number;
  tabs: TabGeometry[];
};

type ToolbarButtonGeometry = {
  idx: number;
  cmd: number;
  hidden: boolean;
  rect: LayoutRect;
};

type ChromeSnapshot = {
  layout: LayoutInfo;
  frame: LayoutRect;
  canvas: LayoutRect;
  toolbarWindow: LayoutRect;
  tabs: LayoutRect;
  tabsGeometry: TabsGeometry;
  toolbarButtons: ToolbarButtonGeometry[];
};

function parseTabsGeometry(raw: string): TabsGeometry {
  const header = /^tabs=(\d+) selected=(-?\d+) tabWidth=(-?\d+)$/m.exec(raw);
  if (!header) {
    throw new Error(`tab-switch-geometry: invalid tab geometry:\n${raw}`);
  }
  const tabs = [...raw.matchAll(/^idx=(\d+) selected=(\d+) rect=(-?\d+),(-?\d+),(-?\d+),(-?\d+)$/gm)].map(
    (match) => ({
      selected: Number(match[2]) !== 0,
      rect: { x: Number(match[3]), y: Number(match[4]), dx: Number(match[5]), dy: Number(match[6]) },
    }),
  );
  if (tabs.length !== Number(header[1])) {
    throw new Error(`tab-switch-geometry: tab count mismatch:\n${raw}`);
  }
  return {
    count: Number(header[1]),
    selected: Number(header[2]),
    tabWidth: Number(header[3]),
    tabs,
  };
}

function parseToolbarGeometry(raw: string): ToolbarButtonGeometry[] {
  return [...raw.matchAll(/^idx=(\d+) cmd=(-?\d+) hidden=(\d+) rect=(-?\d+),(-?\d+),(-?\d+),(-?\d+) text=.*$/gm)].map(
    (match) => ({
      idx: Number(match[1]),
      cmd: Number(match[2]),
      hidden: Number(match[3]) !== 0,
      rect: {
        x: Number(match[4]),
        y: Number(match[5]),
        dx: Number(match[6]) - Number(match[4]),
        dy: Number(match[7]) - Number(match[5]),
      },
    }),
  );
}

async function chromeSnapshot(client: ControlClient): Promise<ChromeSnapshot> {
  const layout = await client.layout();
  const toolbarRaw = String((await client.request(ControlCommand.TestToolbarButtons))[1] ?? "");
  const tabsRaw = String((await client.request(ControlCommand.TestTabsGeometry))[1] ?? "");
  return {
    layout,
    frame: item(layout, "frame"),
    canvas: item(layout, "canvas"),
    toolbarWindow: item(layout, "toolbar"),
    tabs: item(layout, "tabs"),
    tabsGeometry: parseTabsGeometry(tabsRaw),
    toolbarButtons: parseToolbarGeometry(toolbarRaw),
  };
}

async function snapshot(client: ControlClient) {
  const chrome = await chromeSnapshot(client);
  return { ...chrome, pages: pageCount(chrome.layout), relayouts: chrome.layout.count };
}

async function snapshotHome(client: ControlClient) {
  const chrome = await chromeSnapshot(client);
  if (pageCountOrUnknown(chrome.layout) >= 0) {
    throw new Error(`tab-switch-geometry: expected Home without a document:\n${chrome.layout.raw}`);
  }
  return chrome;
}

function sameRect(a: LayoutRect, b: LayoutRect): boolean {
  return a.x === b.x && a.y === b.y && a.dx === b.dx && a.dy === b.dy;
}

function sameTabsGeometry(a: ChromeSnapshot, b: ChromeSnapshot): boolean {
  const ag = a.tabsGeometry;
  const bg = b.tabsGeometry;
  if (ag.count !== bg.count || ag.tabWidth !== bg.tabWidth || ag.tabs.length !== bg.tabs.length) {
    return false;
  }
  return ag.tabs.every((tab, i) => sameRect(tab.rect, bg.tabs[i].rect));
}

function sameToolbarGeometry(a: ChromeSnapshot, b: ChromeSnapshot): boolean {
  const ab = a.toolbarButtons;
  const bb = b.toolbarButtons;
  if (ab.length !== bb.length) {
    return false;
  }
  return ab.every(
    (button, i) =>
      button.idx === bb[i].idx &&
      button.cmd === bb[i].cmd &&
      sameRect(button.rect, bb[i].rect),
  );
}

function sameChromeGeometry(a: ChromeSnapshot, b: ChromeSnapshot): boolean {
  return (
    sameRect(a.frame, b.frame) &&
    sameRect(a.canvas, b.canvas) &&
    sameRect(a.toolbarWindow, b.toolbarWindow) &&
    sameRect(a.tabs, b.tabs) &&
    sameTabsGeometry(a, b) &&
    sameToolbarGeometry(a, b)
  );
}

function geometrySummary(snapshot: ChromeSnapshot): string {
  return JSON.stringify({
    frame: snapshot.frame,
    canvas: snapshot.canvas,
    toolbar: snapshot.toolbarWindow,
    tabs: snapshot.tabs,
    tabItems: snapshot.tabsGeometry.tabs.map((tab) => tab.rect),
    toolbarItems: snapshot.toolbarButtons.map((button) => ({
      idx: button.idx,
      cmd: button.cmd,
      hidden: button.hidden,
      rect: button.rect,
    })),
  });
}

function assertTransitionSamples(label: string, samples: ChromeSnapshot[], source: ChromeSnapshot, target: ChromeSnapshot): void {
  for (const [i, sample] of samples.entries()) {
    if (sameChromeGeometry(sample, source) || sameChromeGeometry(sample, target)) {
      continue;
    }
    throw new Error(
      `tab-switch-geometry: transient chrome geometry on ${label} sample=${i}\n` +
        `current=${geometrySummary(sample)}\nsource=${geometrySummary(source)}\ntarget=${geometrySummary(target)}`,
    );
  }
}

function assertSameChrome(label: string, expected: ChromeSnapshot, current: ChromeSnapshot): void {
  for (const [name, a, b] of [
    ["frame", expected.frame, current.frame],
    ["canvas", expected.canvas, current.canvas],
    ["toolbar-window", expected.toolbarWindow, current.toolbarWindow],
    ["tabs", expected.tabs, current.tabs],
  ] as const) {
    if (!sameRect(a, b)) {
      throw new Error(
        `tab-switch-geometry: ${name} moved ${label} ` +
          `(baseline=${JSON.stringify(a)} current=${JSON.stringify(b)})`,
      );
    }
  }
  if (!sameTabsGeometry(expected, current)) {
    throw new Error(
      `tab-switch-geometry: tab items moved ${label}\n` +
        `baseline=${geometrySummary(expected)}\ncurrent=${geometrySummary(current)}`,
    );
  }
  if (!sameToolbarGeometry(expected, current)) {
    throw new Error(
      `tab-switch-geometry: toolbar items moved ${label}\n` +
        `baseline=${geometrySummary(expected)}\ncurrent=${geometrySummary(current)}`,
    );
  }
}

async function switchTab(client: ControlClient, frame: number, command: number, wantPages: number) {
  await client.layout("reset");
  sendCommandSync(frame, command);
  const deadline = Date.now() + 15000;
  const samples: ChromeSnapshot[] = [];
  let chrome = await chromeSnapshot(client);
  samples.push(chrome);
  let layout = chrome.layout;
  while (pageCountOrUnknown(layout) !== wantPages && Date.now() < deadline) {
    await sleep(50);
    chrome = await chromeSnapshot(client);
    samples.push(chrome);
    layout = chrome.layout;
  }
  if (pageCountOrUnknown(layout) !== wantPages) {
    throw new Error(`tab-switch-geometry: did not reach ${wantPages} pages:\n${layout.raw}`);
  }
  await client.waitForRenderIdle();
  const current = await snapshot(client);
  samples.push(current);
  return { current, samples };
}

async function switchHome(client: ControlClient, frame: number, command: number) {
  await client.layout("reset");
  sendCommandSync(frame, command);
  const deadline = Date.now() + 15000;
  const samples: ChromeSnapshot[] = [];
  let chrome = await chromeSnapshot(client);
  samples.push(chrome);
  let layout = chrome.layout;
  while (pageCountOrUnknown(layout) >= 0 && Date.now() < deadline) {
    await sleep(50);
    chrome = await chromeSnapshot(client);
    samples.push(chrome);
    layout = chrome.layout;
  }
  if (pageCountOrUnknown(layout) >= 0) {
    throw new Error(`tab-switch-geometry: did not reach Home:\n${layout.raw}`);
  }
  const current = await snapshotHome(client);
  samples.push(current);
  return { current, samples };
}

export async function testit(): Promise<void> {
  const dir = tmpPath("ad-hoc-tab-switch-geometry");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const paths = [7, 38, 1234].map((count) => {
    const path = join(dir, `${count}.pdf`);
    writeFileSync(path, makePdf(count), "latin1");
    return path;
  });
  const appdata = writeAppdata(
    "ad-hoc-tab-switch-geometry-appdata",
    "ShowStartPage = false\nShowToc = false\nShowFavorites = false\nShowToolbar = true\nUseTabs = true\n",
  );
  const { proc, client, frame } = await launchControlled(["-appdata", appdata, paths[0]]);
  try {
    await client.waitForRenderIdle();
    for (const path of paths.slice(1)) {
      const openPath = path.replaceAll("\\", "/");
      if (!sendCopyDataW(frame, kCopyDataDdeW, `[Open("${openPath}", 0, 1, 0)]`)) {
        throw new Error(`tab-switch-geometry: DDE Open failed: ${path}`);
      }
      await waitForTitle(frame, (title) => title.includes(path.split("\\").pop()!));
      await client.waitForRenderIdle();
    }

    const baseline = await snapshot(client);
    const prevTab = cmdId("CmdPrevTab");
    const nextTab = cmdId("CmdNextTab");
    for (const [command, wantPages] of [
      [prevTab, 38],
      [prevTab, 7],
      [nextTab, 38],
      [nextTab, 1234],
    ] as const) {
      const { current } = await switchTab(client, frame, command, wantPages);
      if (current.pages !== wantPages) {
        throw new Error(`tab-switch-geometry: expected ${wantPages} pages, got ${current.pages}`);
      }
      assertSameChrome(`on ${wantPages}-page tab`, baseline, current);
      if (current.pages !== 7 && current.pages !== 38 && current.pages !== 1234) {
        throw new Error(`tab-switch-geometry: unexpected page count ${current.pages}`);
      }
    }

    const homeTransition = await switchHome(client, frame, nextTab);
    const homeBaseline = homeTransition.current;
    assertSameChrome("on Home", baseline, homeBaseline);
    assertTransitionSamples("document to Home", homeTransition.samples, baseline, homeBaseline);

    const fromHomeTransition = await switchTab(client, frame, nextTab, 7);
    const fromHome = fromHomeTransition.current;
    assertSameChrome("after Home", baseline, fromHome);
    assertTransitionSamples("Home to document", fromHomeTransition.samples, homeBaseline, baseline);

    const homeAgainTransition = await switchHome(client, frame, prevTab);
    const homeAgain = homeAgainTransition.current;
    assertSameChrome("on repeated Home", homeBaseline, homeAgain);
    assertTransitionSamples("document to Home again", homeAgainTransition.samples, baseline, homeBaseline);

    const backToDocumentTransition = await switchTab(client, frame, prevTab, 1234);
    const backToDocument = backToDocumentTransition.current;
    assertSameChrome("after returning from Home", baseline, backToDocument);
    assertTransitionSamples("Home to document again", backToDocumentTransition.samples, homeBaseline, baseline);
  } finally {
    client.close();
    await killAndWait(proc);
  }
}

if (import.meta.main) {
  await runStandalone(testit);
}
