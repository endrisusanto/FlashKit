import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const indexPath = resolve(root, "index.html");

function updateLandingPage(nextVersion) {
  if (!existsSync(indexPath)) {
    console.error("index.html not found at root");
    return;
  }

  let content = readFileSync(indexPath, "utf8");

  // 1. Update Title tag
  content = content.replace(
    /<title>FlashKit v\d+\.\d+\.\d+ \| Professional Samsung Bulk Provisioning<\/title>/i,
    `<title>FlashKit v${nextVersion} | Professional Samsung Bulk Provisioning</title>`
  );

  // 2. Update navigation badge
  content = content.replace(
    /<div class="badge-v">INDUSTRIAL GRADE RELEASE V\d+\.\d+\.\d+<\/div>/i,
    `<div class="badge-v">INDUSTRIAL GRADE RELEASE V${nextVersion}</div>`
  );

  // 3. Update download link button text in nav
  content = content.replace(
    /Get v\d+\.\d+\.\d+<\/a>/i,
    `Get v${nextVersion}</a>`
  );
  content = content.replace(
    /Get v\d+\.\d+\.\d+/i,
    `Get v${nextVersion}`
  );

  // 4. Update security badge
  content = content.replace(
    /<span class="section-tag">Protokol Keamanan v\d+\.\d+\.\d+<\/span>/i,
    `<span class="section-tag">Protokol Keamanan v${nextVersion}</span>`
  );

  // 5. Update stable build badge
  content = content.replace(
    /Build v\d+\.\d+\.\d+ Stable \(Production\)/i,
    `Build v${nextVersion} Stable (Production)`
  );

  // 6. Update terminal version indicator
  content = content.replace(
    /<span class="ver">Fedora, RedHat &rsaquo; \d+\.\d+\.\d+<\/span>/i,
    `<span class="ver">Fedora, RedHat &rsaquo; ${nextVersion}</span>`
  );

  // 7. Update Windows Row in download table
  const winPattern = /<td>Windows Installer \(\.exe\)<\/td>\s*<td>\d+\.\d+\.\d+<\/td>\s*<td>x64 \/ ARM64<\/td>\s*<td><a href="[^"]*" class="btn-sm">Download for Windows<\/a><\/td>/i;
  const winReplacement = `<td>Windows Installer (.exe)</td>\n                    <td>${nextVersion}</td>\n                    <td>x64 / ARM64</td>\n                    <td><a href="https://github.com/endrisusanto/FlashKit/releases/download/v${nextVersion}/FlashKit_${nextVersion}_x64-setup.exe" class="btn-sm">Download for Windows</a></td>`;
  content = content.replace(winPattern, winReplacement);

  // 8. Update DEB Row in download table
  const debPattern = /<td>Linux \(\.deb\)<\/td>\s*<td>\d+\.\d+\.\d+<\/td>\s*<td>x64<\/td>\s*<td><a href="[^"]*" class="btn-sm">Download \.DEB<\/a><\/td>/i;
  const debReplacement = `<td>Linux (.deb)</td>\n                    <td>${nextVersion}</td>\n                    <td>x64</td>\n                    <td><a href="https://github.com/endrisusanto/FlashKit/releases/download/v${nextVersion}/FlashKit_${nextVersion}_amd64.deb" class="btn-sm">Download .DEB</a></td>`;
  content = content.replace(debPattern, debReplacement);

  // 9. Update RPM Row in download table
  const rpmPattern = /<td>Linux \(\.rpm\)<\/td>\s*<td>\d+\.\d+\.\d+<\/td>\s*<td>x64<\/td>\s*<td><a href="[^"]*" class="btn-sm">Download \.RPM<\/a><\/td>/i;
  const rpmReplacement = `<td>Linux (.rpm)</td>\n                    <td>${nextVersion}</td>\n                    <td>x64</td>\n                    <td><a href="https://github.com/endrisusanto/FlashKit/releases/download/v${nextVersion}/flashkit_${nextVersion}_amd64.rpm" class="btn-sm">Download .RPM</a></td>`;
  content = content.replace(rpmPattern, rpmReplacement);

  writeFileSync(indexPath, content, "utf8");
  console.log(`[release] Successfully updated index.html to v${nextVersion}`);
}

const args = process.argv.slice(2);
const nextVersion = args[0];
if (!nextVersion) {
  console.error("Please provide next version as argument");
  process.exit(1);
}

updateLandingPage(nextVersion);
