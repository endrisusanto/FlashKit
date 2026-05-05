import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";

let filePaths = {
  bl: "", ap: "", cp: "", csc: "", userdata: "",
};

type DeviceData = {
  path: string;
  port: string;
  status: string; // Ready, Flashing..., Pass, Fail
  progress: number;
  log: string;
  checked: boolean;
};

let knownDevices: Record<string, DeviceData> = {};
let activeModalDevice: string | null = null;
let isFlashing = false;
let confettiInterval: number | null = null;

function getTimestamp() {
  const now = new Date();
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `[${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}]`;
}

function extractUsbPort(path: string) {
  const parts = path.split('/');
  if (parts.length >= 2) return `USB:${parts[parts.length-2]}-${parts[parts.length-1]}`;
  return path;
}

function startConfetti() {
  const container = document.getElementById('confetti-container');
  if (!container) return;
  stopConfetti(); // clear existing
  
  const colors = ['#3b82f6', '#8b5cf6', '#34d399', '#f59e0b', '#ef4444'];
  
  confettiInterval = window.setInterval(() => {
    for(let i=0; i<3; i++) {
      const confetti = document.createElement('div');
      confetti.className = 'confetti-piece';
      confetti.style.left = `${Math.random() * 100}vw`;
      confetti.style.backgroundColor = colors[Math.floor(Math.random() * colors.length)];
      confetti.style.animationDuration = `${Math.random() * 2 + 2}s`;
      container.appendChild(confetti);
      setTimeout(() => confetti.remove(), 4000);
    }
  }, 200);
}

function stopConfetti() {
  if (confettiInterval) {
    window.clearInterval(confettiInterval);
    confettiInterval = null;
  }
  const container = document.getElementById('confetti-container');
  if (container) container.innerHTML = '';
}

function triggerDamage() {
  document.body.classList.add('damage-effect');
  setTimeout(() => document.body.classList.remove('damage-effect'), 400);
}

async function selectFile(type: keyof typeof filePaths) {
  if (isFlashing) return;
  try {
    const selected = await open({
      multiple: false,
      filters: [{ name: 'Firmware', extensions: ['tar.md5', 'tar', 'img', 'lz4'] }]
    });
    if (selected && typeof selected === 'string') assignFile(type, selected);
  } catch (err) { console.error(err); }
}

async function assignFile(type: keyof typeof filePaths, path: string) {
  const inputEl = document.querySelector(`#input-${type}`) as HTMLInputElement;
  const progressEl = document.querySelector(`#progress-${type}`) as HTMLDivElement;
  if (!inputEl || !progressEl) return;
  
  inputEl.value = 'Verifying MD5... 0%';
  inputEl.classList.add('verifying');
  progressEl.style.width = '0%';
  progressEl.style.opacity = '1';

  const unlisten = await listen<string>(`md5-progress-${type}`, (event) => {
    const message = event.payload;
    const percentageMatches = message.match(/\((\d+)%\)/g);
    if (percentageMatches) {
      const percentageStr = percentageMatches[percentageMatches.length - 1].replace(/\D/g, '');
      const percentage = parseInt(percentageStr, 10);
      inputEl.value = `Verifying MD5... ${percentage}%`;
      progressEl.style.width = `${percentage}%`;
    }
  });

  try {
    await invoke<string>("check_file", { path, slot: type });
    filePaths[type] = path;
    inputEl.classList.remove('verifying');
    inputEl.value = path.split(/[/\\]/).pop() || path;
    setTimeout(() => { progressEl.style.opacity = '0'; }, 1000);
  } catch (err) {
    filePaths[type] = "";
    inputEl.classList.remove('verifying');
    inputEl.value = "ERROR: Invalid MD5!";
    progressEl.style.width = '0%';
    alert(`File Verification Failed for ${type.toUpperCase()}:\n${err}`);
  } finally {
    unlisten();
  }
}

function clearFiles() {
  filePaths = { bl: "", ap: "", cp: "", csc: "", userdata: "" };
  ['bl', 'ap', 'cp', 'csc', 'userdata'].forEach(type => {
    const inputEl = document.querySelector(`#input-${type}`) as HTMLInputElement;
    const progressEl = document.querySelector(`#progress-${type}`) as HTMLDivElement;
    if (inputEl) {
      inputEl.value = "";
      inputEl.classList.remove('verifying');
    }
    if (progressEl) {
      progressEl.style.width = '0%';
      progressEl.style.opacity = '0';
    }
  });
}

async function parseDroppedFile(path: string) {
  if (isFlashing) return;
  const filename = (path.split(/[/\\]/).pop() || "").toUpperCase();
  if (filename.startsWith('BL_')) await assignFile('bl', path);
  else if (filename.startsWith('AP_') || filename.startsWith('ALL_')) await assignFile('ap', path);
  else if (filename.startsWith('CP_')) await assignFile('cp', path);
  else if (filename.startsWith('CSC_') || filename.startsWith('HOME_CSC_')) await assignFile('csc', path);
  else if (filename.startsWith('USERDATA_')) await assignFile('userdata', path);
  else if (!filePaths.ap) await assignFile('ap', path);
}

function openLogModal(device: string) {
  activeModalDevice = device;
  const modal = document.getElementById('log-modal');
  const modalTitle = document.getElementById('modal-title');
  const modalLog = document.getElementById('modal-log-content');
  if (modal && modalTitle && modalLog && knownDevices[device]) {
    modalTitle.textContent = `Log for ${device}`;
    modalLog.textContent = knownDevices[device].log;
    modalLog.scrollTop = modalLog.scrollHeight;
    modal.classList.remove('hidden');
  }
}

function closeLogModal() {
  activeModalDevice = null;
  document.getElementById('log-modal')?.classList.add('hidden');
}

function renderDeviceCard(device: string, isConnected: boolean) {
  const data = knownDevices[device];
  const devIdStr = device.replace(/[^a-zA-Z0-9]/g, '-');
  
  let statusDisplay = isConnected ? data.status : `<span class="dev-status-offline">${data.status} (Offline)</span>`;
  if (!isConnected && data.status === 'Pass') {
    statusDisplay = `<span class="dev-status-success">Odin Berhasil !</span>`;
  }
  
  let existingCard = document.getElementById(`card-${devIdStr}`);
  
  if (existingCard) {
    const statusEl = existingCard.querySelector(`#status-${devIdStr}`);
    if (statusEl) statusEl.innerHTML = statusDisplay;
    const progTextEl = existingCard.querySelector(`#prog-text-${devIdStr}`);
    if (progTextEl) progTextEl.textContent = `${data.progress}%`;
    const devBgEl = existingCard.querySelector(`#dev-bg-${devIdStr}`) as HTMLElement;
    if (devBgEl) devBgEl.style.width = `${data.progress}%`;
    
    const checkbox = existingCard.querySelector(`#chk-device-${devIdStr}`) as HTMLInputElement;
    if (checkbox) {
      checkbox.disabled = !isConnected;
      checkbox.checked = data.checked;
    }
    return existingCard;
  }

  const card = document.createElement('div');
  card.className = 'device-card';
  card.id = `card-${devIdStr}`;
  card.addEventListener('click', () => {
    openLogModal(device);
  });
  
  const bgFill = document.createElement('div');
  bgFill.className = 'dev-progress-bg';
  bgFill.id = `dev-bg-${devIdStr}`;
  bgFill.style.width = `${data.progress}%`;
  
  const contentDiv = document.createElement('div');
  contentDiv.className = 'dev-content';

  const iconArea = document.createElement('div');
  iconArea.className = 'dev-icon-area';
  iconArea.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2" width="14" height="20" rx="2" ry="2"></rect><line x1="12" y1="18" x2="12.01" y2="18"></line></svg>`;

  const infoArea = document.createElement('div');
  infoArea.className = 'dev-info-area';

  const checkWrapper = document.createElement('div');
  checkWrapper.className = 'custom-check-wrapper';
  
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.id = `chk-device-${devIdStr}`;
  checkbox.value = device;
  checkbox.checked = data.checked;
  if (!isConnected) checkbox.disabled = true;

  const customCheck = document.createElement('div');
  customCheck.className = 'custom-checkbox';
  customCheck.innerHTML = `<svg viewBox="0 0 24 24"><path d="M5 12l5 5L20 7"></path></svg>`;

  checkWrapper.appendChild(checkbox);
  checkWrapper.appendChild(customCheck);

  checkWrapper.addEventListener('click', (e) => {
    e.stopPropagation(); // prevent modal from opening
    if (!isConnected || isFlashing) return;
    data.checked = !data.checked;
    checkbox.checked = data.checked;
  });

  
  const title = document.createElement('h3');
  title.className = 'dev-title';
  title.innerHTML = `Device: <span id="status-${devIdStr}" style="margin-left:auto;">${statusDisplay}</span>`;
  
  const pathLabel = document.createElement('p');
  pathLabel.className = 'dev-path';
  pathLabel.innerHTML = `${data.port} <span style="float:right; font-weight:600;" id="prog-text-${devIdStr}">${data.progress}%</span>`;

  infoArea.appendChild(checkWrapper);
  infoArea.appendChild(title);
  infoArea.appendChild(pathLabel);
  
  contentDiv.appendChild(iconArea);
  contentDiv.appendChild(infoArea);
  
  card.appendChild(bgFill);
  card.appendChild(contentDiv);
  return card;
}

let activeListeners: Record<string, () => void> = {};

async function setupListenerFor(device: string) {
  if (activeListeners[device]) return;
  const unlisten = await listen<string>(`flash-progress-${device}`, (event) => {
    logToDevice(device, event.payload);
  });
  // @ts-ignore
  activeListeners[device] = unlisten;
}

async function performSmartScan() {
  if (isFlashing) return;
  try {
    const listEl = document.querySelector('#device-list') as HTMLDivElement;
    const newDevicesList = await invoke<string[]>("list_devices");
    
    // Add new devices to history
    newDevicesList.forEach(dev => {
      if (!knownDevices[dev]) {
        knownDevices[dev] = {
          path: dev,
          port: extractUsbPort(dev),
          status: 'Ready',
          progress: 0,
          checked: true,
          log: `${getTimestamp()} Attached at ${dev}\n${getTimestamp()} Waiting for flash command...`
        };
        setupListenerFor(dev);
      }
    });

    // Determine which devices to render
    const toRender = Object.keys(knownDevices).filter(dev => {
      const isConnected = newDevicesList.includes(dev);
      const data = knownDevices[dev];
      if (isConnected) return true;
      if (data.status === 'Pass' || data.status === 'Fail') return true;
      return false;
    });

    if (toRender.length === 0) {
      if(!listEl.innerHTML.includes('device-skeleton')) {
        listEl.innerHTML = `
          <div class="device-skeleton"></div>
          <div class="device-skeleton"></div>
          <div class="device-skeleton"></div>
          <div class="device-skeleton"></div>
        `;
      }
      return;
    }

    // Remove old cards or skeletons
    const currentCards = Array.from(listEl.children);
    currentCards.forEach(child => {
       if (child.classList.contains('device-skeleton')) {
           child.remove();
       } else {
           const id = child.id.replace('card-', '');
           const devObj = toRender.find(d => d.replace(/[^a-zA-Z0-9]/g, '-') === id);
           if (!devObj) child.remove();
       }
    });

    // Add or update valid cards
    toRender.forEach(dev => {
      const isConnected = newDevicesList.includes(dev);
      const card = renderDeviceCard(dev, isConnected);
      if (!listEl.contains(card)) {
          listEl.appendChild(card);
      }
    });
    
  } catch (err) {
    console.error("Scan error", err);
  }
}

async function forceRefreshDevices() {
  stopConfetti(); // clear visual effects on refresh
  const listEl = document.querySelector('#device-list') as HTMLDivElement;
  listEl.innerHTML = `
    <div class="device-skeleton"></div>
    <div class="device-skeleton"></div>
    <div class="device-skeleton"></div>
    <div class="device-skeleton"></div>
  `;
  // Clean ALL history unconditionally when user hits Refresh
  Object.keys(knownDevices).forEach(dev => {
    delete knownDevices[dev];
    if(activeListeners[dev]) {
      // @ts-ignore
      activeListeners[dev]();
      delete activeListeners[dev];
    }
  });
  await performSmartScan();
}

function updateProgress(device: string, percentage: number) {
  if (knownDevices[device]) {
    knownDevices[device].progress = percentage;
  }
  const devIdStr = device.replace(/[^a-zA-Z0-9]/g, '-');
  const devBg = document.getElementById(`dev-bg-${devIdStr}`);
  const devText = document.getElementById(`prog-text-${devIdStr}`);
  if (devBg && devText) {
    devBg.style.width = `${percentage}%`;
    devText.textContent = `${percentage}%`;
  }
}

function logToDevice(device: string, message: string) {
  if (!knownDevices[device]) return;
  const percentageMatches = message.match(/\((\d+)%\)/g);
  let cleanMessage = message;
  
  if (percentageMatches) {
    const percentage = parseInt(percentageMatches[percentageMatches.length - 1].replace(/\D/g, ''), 10);
    updateProgress(device, percentage);
    cleanMessage = message.replace(/\(\d+%\)/g, '').trim();
    if(cleanMessage === '') return;
  }
  
  knownDevices[device].log += `\n${getTimestamp()} ${cleanMessage}`;
  
  if (activeModalDevice === device) {
    const modalLog = document.getElementById('modal-log-content');
    if (modalLog) {
      modalLog.textContent = knownDevices[device].log;
      modalLog.scrollTop = modalLog.scrollHeight;
    }
  }
}

function toggleFlashingUI(active: boolean) {
  isFlashing = active;
  document.querySelectorAll('.file-input-wrapper').forEach(el => {
    active ? el.classList.add('flashing-disabled') : el.classList.remove('flashing-disabled');
  });
  (document.getElementById('btn-clear-files') as HTMLButtonElement).disabled = active;
  (document.getElementById('btn-refresh-devices') as HTMLButtonElement).disabled = active;
  
  const gear = document.getElementById('btn-gear');
  const text = document.getElementById('btn-text');
  if (gear && text) {
    if (active) {
      gear.classList.remove('hidden');
      text.textContent = 'FLASHING...';
    } else {
      gear.classList.add('hidden');
      text.textContent = 'START FLASHING';
    }
  }
}

async function startFlash() {
  const checkboxes = document.querySelectorAll('.device-card input[type="checkbox"]:checked:not([disabled])') as NodeListOf<HTMLInputElement>;
  if (checkboxes.length === 0) return;

  stopConfetti();
  toggleFlashingUI(true);
  const flashBtn = document.getElementById('btn-flash') as HTMLButtonElement;
  flashBtn.disabled = true;

  let anyFail = false;
  let anyPass = false;

  const promises = Array.from(checkboxes).map(async (chk) => {
    const device = chk.value;
    const devIdStr = device.replace(/[^a-zA-Z0-9]/g, '-');
    const statusEl = document.getElementById(`status-${devIdStr}`);
    const cardEl = document.getElementById(`card-${devIdStr}`);
    
    if(knownDevices[device]) knownDevices[device].status = 'Flashing...';
    if(statusEl) statusEl.textContent = 'Flashing...';
    if(cardEl) cardEl.classList.add('flashing-state');
    
    logToDevice(device, `=====================\nSTARTING ODIN ENGINE\n=====================`);
    updateProgress(device, 0);
    
    try {
      const result: string = await invoke("flash_device", {
        params: { device, bl: filePaths.bl, ap: filePaths.ap, cp: filePaths.cp, csc: filePaths.csc, userdata: filePaths.userdata }
      });
      updateProgress(device, 100);
      if(knownDevices[device]) knownDevices[device].status = 'Pass';
      if(statusEl) statusEl.textContent = 'Pass';
      logToDevice(device, `\n=====================\n${result}\n=====================`);
      anyPass = true;
    } catch (err) {
      if(knownDevices[device]) knownDevices[device].status = 'Fail';
      if(statusEl) statusEl.textContent = 'Fail';
      logToDevice(device, `\n=====================\nERROR: ${err}\n=====================`);
      anyFail = true;
    } finally {
      if(cardEl) cardEl.classList.remove('flashing-state');
    }
  });

  await Promise.all(promises);
  
  flashBtn.disabled = false;
  toggleFlashingUI(false);

  if (anyFail) {
    triggerDamage();
  } else if (anyPass) {
    startConfetti();
  }
}

window.addEventListener("DOMContentLoaded", () => {
  ['bl', 'ap', 'cp', 'csc', 'userdata'].forEach(type => {
    document.querySelector(`#row-${type} .file-input-wrapper`)?.addEventListener("click", () => selectFile(type as keyof typeof filePaths));
  });
  
  document.querySelector("#btn-clear-files")?.addEventListener("click", clearFiles);
  document.querySelector("#btn-refresh-devices")?.addEventListener("click", forceRefreshDevices);
  document.querySelector("#btn-flash")?.addEventListener("click", startFlash);
  document.querySelector("#btn-close-modal")?.addEventListener("click", closeLogModal);
});

listen<{paths: string[]}>('tauri://drag-drop', event => {
  document.getElementById('drop-overlay')?.classList.add('hidden');
  for (const path of event.payload.paths) parseDroppedFile(path);
});

listen('tauri://drag-enter', () => document.getElementById('drop-overlay')?.classList.remove('hidden'));
listen('tauri://drag-leave', () => document.getElementById('drop-overlay')?.classList.add('hidden'));

forceRefreshDevices();
window.setInterval(performSmartScan, 2000);
