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
  const match = /pages count=(\d+)/.exec(layout.raw);
  if (!match) {
    throw new Error(`tab-switch-geometry: page count missing in:\n${layout.raw}`);
  }
  return Number(match[1]);
}

function toolbarRect(raw: string, command: number): LayoutRect {
  const pattern = `^idx=\\d+ cmd=${command} hidden=0 rect=(-?\\d+),(-?\\d+),(-?\\d+),(-?\\d+)`;
  const match = new RegExp(pattern, "m").exec(raw);
  if (!match) {
    throw new Error(`tab-switch-geometry: toolbar command ${command} missing in:\n${raw}`);
  }
  return {
    x: Number(match[1]),
    y: Number(match[2]),
    dx: Number(match[3]) - Number(match[1]),
    dy: Number(match[4]) - Number(match[2]),
  };
}

async function snapshot(client: ControlClient) {
  const layout = await client.layout();
  const toolbar = String((await client.request(ControlCommand.TestToolbarButtons))[1] ?? "");
  return {
    pages: pageCount(layout),
    relayouts: layout.count,
    frame: item(layout, "frame"),
    canvas: item(layout, "canvas"),
    tabs: item(layout, "tabs"),
    previousPage: toolbarRect(toolbar, cmdId("CmdGoToPrevPage")),
  };
}

function sameRect(a: LayoutRect, b: LayoutRect): boolean {
  return a.x === b.x && a.y === b.y && a.dx === b.dx && a.dy === b.dy;
}

async function switchTab(client: ControlClient, frame: number, command: number, wantPages: number) {
  await client.layout("reset");
  sendCommandSync(frame, command);
  const deadline = Date.now() + 15000;
  let layout = await client.layout();
  while (pageCount(layout) !== wantPages && Date.now() < deadline) {
    await sleep(50);
    layout = await client.layout();
  }
  if (pageCount(layout) !== wantPages) {
    throw new Error(`tab-switch-geometry: did not reach ${wantPages} pages:\n${layout.raw}`);
  }
  await client.waitForRenderIdle();
  return snapshot(client);
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
      [nextTab, 7],
    ] as const) {
      const current = await switchTab(client, frame, command, wantPages);
      if (current.pages !== wantPages) {
        throw new Error(`tab-switch-geometry: expected ${wantPages} pages, got ${current.pages}`);
      }
      for (const [name, a, b] of [
        ["frame", baseline.frame, current.frame],
        ["canvas", baseline.canvas, current.canvas],
        ["tabs", baseline.tabs, current.tabs],
        ["previous-page", baseline.previousPage, current.previousPage],
      ] as const) {
        if (!sameRect(a, b)) {
          throw new Error(
            `tab-switch-geometry: ${name} moved on ${wantPages}-page tab ` +
              `(baseline=${JSON.stringify(a)} current=${JSON.stringify(b)})`,
          );
        }
      }
      if (current.pages !== 7 && current.pages !== 38 && current.pages !== 1234) {
        throw new Error(`tab-switch-geometry: unexpected page count ${current.pages}`);
      }
    }
  } finally {
    client.close();
    await killAndWait(proc);
  }
}

if (import.meta.main) {
  await runStandalone(testit);
}
