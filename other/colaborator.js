// Name: DANV Collaborative Workspace
// ID: liveblockscollab
// Description: Nền tảng làm việc nhóm và cộng tác theo thời gian thực dành cho dự án.
// By: StudioDANV
// License: MIT

(async function(Scratch) {
    'use strict';

    if (!Scratch.extensions.unsandboxed) {
        alert('Hệ thống: Tiện ích mở rộng yêu cầu chạy ở chế độ Unsandboxed.');
        return;
    }

    console.log("[DANV Workspace ⏳] Đang khởi tạo thư viện cộng tác...");
    const { createClient, LiveMap } = await import('https://esm.sh/@liveblocks/client?bundle');

    // 1. MÁY CHỦ TRUNG TÂM (LƯU TRỮ DỰ ÁN ĐỒNG BỘ)
    const CLOUDFLARE_URL = "https://collab-extension.danvws.workers.dev";

    // 2. KẾT NỐI THỜI GIAN THỰC (XỬ LÝ CHUỘT, TRÒ CHUYỆN, KHÓA TÀI NGUYÊN)
    const PUBLIC_API_KEY = "pk_dev_kA8Le_ojSQGAiMqwZu_gKFmMeznbD-5AN28BbxPYRaxYEIXUmc09Ewht7ylMt1JT"; 
    const client = createClient({ publicApiKey: PUBLIC_API_KEY });

    let room = null;
    let currentRoomId = null;
    let myUserName = localStorage.getItem('collab_username') || ('User_' + Math.floor(1000 + Math.random() * 9000));
    let cursorsContainer = null;
    let cursorElements = new Map();
    let lastMouseTime = 0;
    let navBarBadgeEl = null;

    let sharedBlocks = null; 
    let isApplyingRemote = false;
    let remoteOpDepth = 0;
    
    function isRemoteActive() { return remoteOpDepth > 0 || isApplyingRemote; } 
    function enterRemoteScope() { remoteOpDepth++; }
    function exitRemoteScope() { remoteOpDepth = Math.max(0, remoteOpDepth - 1); }

    let isCostumeLocked = false;
    const incomingTransfers = new Map();
    const handledActionIds = new Set();
    const spriteVersions = new Map();
    const blockSyncDebounceTimers = new Map();
    let activeCostumeLockTimeout = null;
    let liveCostumeSyncInterval = null;
    let lastSentCostumeDataURI = null;
    let loadingOverlayEl = null;

    const DANV_LOGO_URL = 'https://github.com/danvPR/workshop/blob/main/Assets/Logo-Vi.png?raw=true';

    // BỘ ICON VECTOR TURBOWARP
    const ICONS = {
        users: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>`,
        exit: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path><polyline points="16 17 21 12 16 7"></polyline><line x1="21" y1="12" x2="9" y2="12"></line></svg>`,
        chat: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>`,
        send: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>`,
        lock: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#ff4d4f" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>`,
        close: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`,
        copy: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`,
        check: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#2fd67c" stroke-width="2.5"><polyline points="20 6 9 17 4 12"></polyline></svg>`
    };

    // MÀN HÌNH LOADING
    function showLoadingScreen(title = 'Đang đồng bộ...', subtitle = 'Vui lòng chờ...', percent = 0) {
        if (!loadingOverlayEl) {
            loadingOverlayEl = document.createElement('div');
            loadingOverlayEl.id = 'collab-loading-screen';
            loadingOverlayEl.style.cssText = `
                position: fixed; inset: 0; background: rgba(18, 20, 29, 0.94);
                backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
                z-index: 10000005; display: flex; flex-direction: column;
                align-items: center; justify-content: center;
                font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
                color: #fff; user-select: none; transition: opacity 0.25s ease;
            `;
            document.body.appendChild(loadingOverlayEl);
        }
        loadingOverlayEl.style.display = 'flex';
        loadingOverlayEl.style.opacity = '1';
        loadingOverlayEl.innerHTML = `
            <div style="background:#252839; border:1px solid rgba(255,255,255,0.12); padding:28px 36px; border-radius:12px; box-shadow:0 12px 40px rgba(0,0,0,0.6); display:flex; flex-direction:column; align-items:center; width:340px;">
                <img src="${DANV_LOGO_URL}" style="height:36px; width:auto; margin-bottom:14px;" />
                <div style="font-size:16px; font-weight:600; margin-bottom:6px; color:#fff;" id="collab-load-title">${title}</div>
                <div style="font-size:12.5px; color:#8e96aa; margin-bottom:18px; text-align:center;" id="collab-load-sub">${subtitle}</div>
                <div style="width:100%; height:7px; background:#181924; border-radius:10px; overflow:hidden; border:1px solid rgba(255,255,255,0.06); margin-bottom:10px;">
                    <div id="collab-load-bar" style="width:${Math.min(100, Math.max(5, percent))}%; height:100%; background:linear-gradient(90deg, #4C97FF, #2fd67c); border-radius:10px; transition:width 0.2s ease;"></div>
                </div>
                <div style="font-size:11px; color:#676e82; font-weight:500;" id="collab-load-percent">${percent}%</div>
            </div>
        `;
    }

    function updateLoadingProgress(title, subtitle, percent) {
        if (!loadingOverlayEl) return;
        const t = loadingOverlayEl.querySelector('#collab-load-title');
        const s = loadingOverlayEl.querySelector('#collab-load-sub');
        const b = loadingOverlayEl.querySelector('#collab-load-bar');
        const p = loadingOverlayEl.querySelector('#collab-load-percent');
        if (t && title) t.textContent = title;
        if (s && subtitle) s.textContent = subtitle;
        if (b && percent !== undefined) b.style.width = `${Math.min(100, Math.max(5, percent))}%`;
        if (p && percent !== undefined) p.textContent = `${percent}%`;
    }

    function hideLoadingScreen() {
        if (!loadingOverlayEl) return;
        loadingOverlayEl.style.opacity = '0';
        setTimeout(() => { if (loadingOverlayEl) loadingOverlayEl.style.display = 'none'; }, 250);
    }

    // --- HỆ THỐNG ĐỒNG BỘ DỰ ÁN 24/7 VỚI CLOUDFLARE ---
    let cloudflareSaveTimer = null;
    function scheduleCloudflareSave(delay = 1500, broadcastAfter = false) {
        if (!currentRoomId || isRemoteActive()) return;
        if (cloudflareSaveTimer) clearTimeout(cloudflareSaveTimer);
        cloudflareSaveTimer = setTimeout(async () => {
            try {
                // 1. Tải toàn bộ tài nguyên nhị phân lên Cloudflare R2 trước
                for (const t of Scratch.vm.runtime.targets) {
                    await syncTargetAssetsToR2(t);
                }
                // 2. Tải snapshot dự án lên Cloudflare Durable Object
                const snapshot = packCurrentProject();
                const res = await fetch(`${CLOUDFLARE_URL}/project?room=${encodeURIComponent(currentRoomId)}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(snapshot)
                });

                if (res.ok) {
                    console.log("[DANV Workspace ☁️] Đã sao lưu tiến độ và đồng bộ tài nguyên dự án.");
                    // CHỈ PHÁT SÓNG CHO CÁC MÁY KHÁC SAU KHI DỮ LIỆU ĐÃ LÊN MÁY CHỦ
                    if (broadcastAfter && room) {
                        room.broadcastEvent({ type: 'SYNC_CLOUD_REFRESH' });
                    }
                }
            } catch (e) {
                console.error("[DANV Workspace ❌] Lỗi kết nối tới máy chủ lưu trữ:", e);
            }
        }, delay);
    }

    function packCurrentProject() {
        const stageTarget = Scratch.vm.runtime.targets.find(t => t.isStage);
        const sprites = Scratch.vm.runtime.targets.filter(t => !t.isStage);

        const stageData = stageTarget ? {
            currentCostume: stageTarget.currentCostume,
            costumes: (stageTarget.sprite.costumes || []).map(serializeCostume),
            sounds: (stageTarget.sprite.sounds || []).map(serializeSound),
            blocks: stageTarget.blocks ? stageTarget.blocks._blocks : {},
            comments: stageTarget.blocks ? stageTarget.blocks._comments : {},
            variables: stageTarget.variables ? JSON.parse(JSON.stringify(stageTarget.variables)) : {}
        } : null;

        const spritesData = [];
        for (const sp of sprites) {
            const tj = sp.toJSON();
            tj.blocks = {};
            tj.sounds = [];
            spritesData.push({
                name: sp.sprite.name,
                targetJSON: tj,
                costumes: (sp.sprite.costumes || []).map(serializeCostume),
                sounds: (sp.sprite.sounds || []).map(serializeSound),
                blocks: sp.blocks ? sp.blocks._blocks : {},
                comments: sp.blocks ? sp.blocks._comments : {}
            });
        }

        return { stage: stageData, sprites: spritesData, timestamp: Date.now() };
    }

    async function restoreProjectFromCloudflare(roomId) {
        try {
            updateLoadingProgress('Đang kết nối máy chủ...', 'Đang đồng bộ khối lượng dữ liệu...', 45);
            const res = await fetch(`${CLOUDFLARE_URL}/project?room=${encodeURIComponent(roomId)}`);
            if (!res.ok) return false;
            const resJson = await res.json();
            if (!resJson.exists || !resJson.data) return false;

            const snapshot = resJson.data;
            enterRemoteScope();
            try {
                // 1. Nạp Sân khấu (Stage)
                const stageTarget = Scratch.vm.runtime.targets.find(t => t.isStage);
                if (stageTarget && snapshot.stage) {
                    if (snapshot.stage.costumes) {
                        stageTarget.sprite.costumes = [];
                        for (const c of snapshot.stage.costumes) {
                            const cObj = await deserializeCostume(c);
                            if (cObj) stageTarget.addCostume(cObj);
                        }
                    }
                    if (snapshot.stage.sounds) {
                        stageTarget.sprite.sounds = [];
                        for (const s of snapshot.stage.sounds) {
                            const sObj = await deserializeSound(s);
                            if (sObj) stageTarget.sprite.sounds.push(sObj);
                        }
                    }
                    if (typeof snapshot.stage.currentCostume === 'number') {
                        stageTarget.setCostume(snapshot.stage.currentCostume);
                    }
                    if (snapshot.stage.variables) {
                        for (const varId in snapshot.stage.variables) {
                            const vData = snapshot.stage.variables[varId];
                            
                            // Nếu biến chưa tồn tại, yêu cầu VM tạo mới (để kế thừa hàm toXML)
                            if (!stageTarget.variables[varId] && typeof stageTarget.createVariable === 'function') {
                                stageTarget.createVariable(vData.id, vData.name, vData.type, vData.isCloud);
                            }
                            
                            // Cập nhật giá trị một cách an toàn mà không làm mất prototype của VM
                            if (stageTarget.variables[varId]) {
                                stageTarget.variables[varId].name = vData.name;
                                stageTarget.variables[varId].value = vData.value;
                                if (vData.isCloud !== undefined) stageTarget.variables[varId].isCloud = vData.isCloud;
                            }
                        }
                    }
                    if (snapshot.stage.blocks) {
                        applyBlocksToTarget(stageTarget, {
                            blocks: snapshot.stage.blocks,
                            comments: snapshot.stage.comments || {}
                        });
                    }
                }

                // 2. Đồng bộ các Sprite In-Place (Giữ nguyên ID tránh đứt gãy tham chiếu blocks)
                const incomingNames = new Set((snapshot.sprites || []).map(s => s.name));
                const currentSprites = Scratch.vm.runtime.targets.filter(t => !t.isStage);

                // Xóa những sprite không còn tồn tại trên bản lưu máy chủ
                for (const sp of currentSprites) {
                    if (!incomingNames.has(sp.sprite.name)) {
                        Scratch.vm.deleteSprite(sp.id);
                    }
                }

                // Cập nhật hoặc thêm mới từng sprite
                if (snapshot.sprites && Array.isArray(snapshot.sprites)) {
                    for (let i = 0; i < snapshot.sprites.length; i++) {
                        const spData = snapshot.sprites[i];
                        updateLoadingProgress('Đang thiết lập dữ liệu...', `Khởi tạo: ${spData.name} (${i + 1}/${snapshot.sprites.length})...`, 50 + Math.round(((i + 1) / snapshot.sprites.length) * 40));

                        let target = Scratch.vm.runtime.targets.find(t => !t.isStage && t.sprite.name === spData.name);
                        if (!target) {
                            // Xóa rỗng danh sách costume/sound tạm thời khi khởi tạo để tránh lỗi thiếu cache assets
                            const cleanJSON = Object.assign({}, spData.targetJSON, { costumes: [], sounds: [], blocks: {} });
                            const added = await Scratch.vm.addSprite(cleanJSON);
                            target = (added && added.id ? added : (Array.isArray(added) ? added[0] : null))
                                || Scratch.vm.runtime.targets[Scratch.vm.runtime.targets.length - 1];
                        }

                        if (target) {
                            if (target.sprite && target.sprite.name !== spData.name) {
                                target.sprite.name = spData.name;
                            }
                            if (spData.costumes) {
                                target.sprite.costumes = [];
                                for (const c of spData.costumes) {
                                    const cObj = await deserializeCostume(c);
                                    if (cObj) target.addCostume(cObj);
                                }
                                // Cập nhật lại costume hiện tại và dựng lại hình ảnh trên WebGL
                                const cIdx = (spData.targetJSON && typeof spData.targetJSON.currentCostume === 'number') 
                                    ? spData.targetJSON.currentCostume : (target.currentCostume || 0);
                                target.setCostume(cIdx);
                                if (typeof target.updateAllDrawableProperties === 'function') {
                                    target.updateAllDrawableProperties();
                                }
                            }
                            if (spData.sounds) {
                                target.sprite.sounds = [];
                                for (const s of spData.sounds) {
                                    const sObj = await deserializeSound(s);
                                    if (sObj) target.sprite.sounds.push(sObj);
                                }
                            }
                            if (spData.blocks) {
                                applyBlocksToTarget(target, {
                                    blocks: spData.blocks,
                                    comments: spData.comments || {}
                                });
                            }
                        }
                    }
                }

                Scratch.vm.emitTargetsUpdate();
                Scratch.vm.emitWorkspaceUpdate();
            } finally {
                exitRemoteScope();
            }
            return true;
        } catch (err) {
            console.error("[DANV Workspace ❌] Lỗi khôi phục dữ liệu từ hệ thống:", err);
            return false;
        }
    }

    // --- BỘ XỬ LÝ QUẢN LÝ TÀI NGUYÊN MỞ RỘNG (KHÔNG SỬ DỤNG BASE64) ---
    const uploadedR2Assets = new Set();

    async function uploadAssetBinaryToR2(fileName, dataBuffer, mimeType) {
        if (!fileName || !dataBuffer || uploadedR2Assets.has(fileName)) return true;
        try {
            const headCheck = await fetch(`${CLOUDFLARE_URL}/asset/${encodeURIComponent(fileName)}`, { method: 'HEAD' });
            if (headCheck.ok) {
                uploadedR2Assets.add(fileName);
                return true;
            }
            const res = await fetch(`${CLOUDFLARE_URL}/asset/${encodeURIComponent(fileName)}`, {
                method: 'PUT',
                headers: { 'Content-Type': mimeType || 'application/octet-stream' },
                body: dataBuffer
            });
            if (res.ok) {
                uploadedR2Assets.add(fileName);
                return true;
            }
        } catch (e) {
            console.warn("[DANV Workspace] Cảnh báo sự cố đường truyền tải tài nguyên:", fileName, e);
        }
        return false;
    }

    async function syncTargetAssetsToR2(target) {
        if (!target || !target.sprite) return;
        const tasks = [];

        for (const c of (target.sprite.costumes || [])) {
            let asset = c.asset;
            if (!asset && c.assetId && Scratch.vm.runtime.storage) asset = Scratch.vm.runtime.storage.get(c.assetId);
            if (asset && asset.data) {
                const fName = c.md5ext || `${c.assetId}.${c.dataFormat}`;
                const mime = c.dataFormat === 'svg' ? 'image/svg+xml' : 'image/png';
                tasks.push(uploadAssetBinaryToR2(fName, asset.data, mime));
            }
        }

        for (const s of (target.sprite.sounds || [])) {
            let asset = s.asset;
            if (!asset && s.assetId && Scratch.vm.runtime.storage) asset = Scratch.vm.runtime.storage.get(s.assetId);
            if (asset && asset.data) {
                const fName = s.md5ext || `${s.assetId}.${s.dataFormat}`;
                const mime = s.dataFormat === 'wav' ? 'audio/wav' : 'audio/mpeg';
                tasks.push(uploadAssetBinaryToR2(fName, asset.data, mime));
            }
        }

        await Promise.all(tasks);
    }

    async function fetchAssetBufferFromR2(fileName) {
        try {
            const res = await fetch(`${CLOUDFLARE_URL}/asset/${encodeURIComponent(fileName)}`);
            if (!res.ok) return null;
            const blob = await res.blob();
            return new Uint8Array(await blob.arrayBuffer());
        } catch (e) {
            console.error("[DANV Workspace] Lỗi truy xuất tài nguyên máy chủ:", fileName, e);
            return null;
        }
    }

    // --- MÃ HÓA & GIẢI MÃ ÂM THANH (CHỈ CHỨA METADATA NHẸ) ---
    function serializeSound(sound) {
        if (!sound) return null;
        return {
            name: sound.name,
            dataFormat: sound.dataFormat,
            assetId: sound.assetId,
            md5ext: sound.md5ext || `${sound.assetId}.${sound.dataFormat}`,
            rate: sound.rate,
            sampleCount: sound.sampleCount
        };
    }

    async function deserializeSound(soundData) {
        if (!soundData) return null;
        const storage = Scratch.vm.runtime.storage;
        const fileName = soundData.md5ext || `${soundData.assetId}.${soundData.dataFormat}`;
        let asset = storage && soundData.assetId ? storage.get(soundData.assetId) : null;

        if (!asset && storage) {
            const buffer = await fetchAssetBufferFromR2(fileName);
            if (buffer) {
                const assetType = storage.AssetType ? storage.AssetType.Sound : 'Sound';
                asset = storage.createAsset(assetType, soundData.dataFormat, buffer, soundData.assetId, false);
            }
        }

        return {
            name: soundData.name,
            dataFormat: soundData.dataFormat,
            asset: asset,
            assetId: soundData.assetId,
            md5: fileName,
            rate: soundData.rate,
            sampleCount: soundData.sampleCount
        };
    }

    // --- MÃ HÓA & GIẢI MÃ TRANG PHỤC (CHỈ CHỨA METADATA NHẸ) ---
    function serializeCostume(costume) {
        if (!costume) return null;
        return {
            name: costume.name,
            dataFormat: costume.dataFormat,
            assetId: costume.assetId,
            md5ext: costume.md5ext || `${costume.assetId}.${costume.dataFormat}`,
            rotationCenterX: costume.rotationCenterX,
            rotationCenterY: costume.rotationCenterY,
            bitmapResolution: costume.bitmapResolution || 1
        };
    }

    async function deserializeCostume(costumeData) {
        if (!costumeData) return null;
        const storage = Scratch.vm.runtime.storage;
        const fileName = costumeData.md5ext || `${costumeData.assetId}.${costumeData.dataFormat}`;
        let asset = storage && costumeData.assetId ? storage.get(costumeData.assetId) : null;

        if (!asset && storage) {
            const buffer = await fetchAssetBufferFromR2(fileName);
            if (buffer) {
                const isSvg = costumeData.dataFormat === 'svg';
                const assetType = isSvg
                    ? (storage.AssetType ? storage.AssetType.ImageVector : 'ImageVector')
                    : (storage.AssetType ? storage.AssetType.ImageBitmap : 'ImageBitmap');
                asset = storage.createAsset(assetType, costumeData.dataFormat, buffer, costumeData.assetId, false);
            }
        }

        const costumeObj = {
            name: costumeData.name,
            dataFormat: costumeData.dataFormat,
            asset: asset,
            assetId: costumeData.assetId,
            md5: fileName,
            rotationCenterX: costumeData.rotationCenterX,
            rotationCenterY: costumeData.rotationCenterY,
            bitmapResolution: costumeData.bitmapResolution || 1,
            size: [0, 0]
        };

        const renderer = Scratch.vm.runtime.renderer;
        if (renderer && asset) {
            try {
                const rotationCenter = [costumeObj.rotationCenterX, costumeObj.rotationCenterY];
                if (costumeObj.dataFormat === 'svg') {
                    costumeObj.skinId = renderer.createSVGSkin(asset.decodeText(), rotationCenter);
                } else {
                    costumeObj.skinId = renderer.createBitmapSkin(asset.data, costumeObj.bitmapResolution, rotationCenter);
                }
                const skinSize = renderer.getSkinSize(costumeObj.skinId);
                costumeObj.size = [skinSize[0], skinSize[1]];
            } catch (err) {
                console.warn("[Collab] WebGL Skin warn:", err);
            }
        }

        return costumeObj;
    }

    function isCostumeTabActive() {
        const tabs = document.querySelectorAll('[class*="react-tabs__tab"], [role="tab"]');
        for (const tab of tabs) {
            const isSelected = tab.getAttribute('aria-selected') === 'true' || 
                               tab.classList.contains('react-tabs__tab--selected');
            if (isSelected) {
                const text = (tab.textContent || '').trim().toLowerCase();
                if (text.includes('costume') || text.includes('trang phục') || text.includes('backdrop') || text.includes('phông nền')) {
                    return true;
                }
            }
        }
        return false;
    }

    // --- GIAO DIỆN PHÒNG & THÀNH VIÊN ---
    let usersPopoverEl = null;
    let isUsersListOpen = false;

    function copyRoomIdToClipboard() {
        if (!currentRoomId) return;
        navigator.clipboard.writeText(currentRoomId).then(() => {
            showCostumeLock(`Đã sao chép mã phòng: "${currentRoomId}"`);
            setTimeout(() => { if (!isCostumeLocked) hideCostumeLock(); }, 2000);
            const copyIcons = document.querySelectorAll('.collab-copy-btn-icon');
            copyIcons.forEach(btn => {
                btn.innerHTML = ICONS.check;
                setTimeout(() => { btn.innerHTML = ICONS.copy; }, 2000);
            });
        });
    }

    function toggleUsersListUI(forceState) {
        isUsersListOpen = (typeof forceState === 'boolean') ? forceState : !isUsersListOpen;
        if (!isUsersListOpen) {
            if (usersPopoverEl) usersPopoverEl.style.display = 'none';
            return;
        }

        if (!usersPopoverEl) {
            usersPopoverEl = document.createElement('div');
            usersPopoverEl.id = 'collab-users-popover';
            usersPopoverEl.style.cssText = `
                position: fixed; width: 280px; background: #252839;
                border: 1px solid rgba(255,255,255,0.15); border-radius: 8px;
                box-shadow: 0 10px 30px rgba(0,0,0,0.5); z-index: 10000002;
                font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
                overflow: hidden; display: flex; flex-direction: column;
            `;
            document.body.appendChild(usersPopoverEl);

            document.addEventListener('pointerdown', (e) => {
                if (!isUsersListOpen || !usersPopoverEl) return;
                const inBadge = navBarBadgeEl && navBarBadgeEl.contains(e.target);
                const inPopover = usersPopoverEl.contains(e.target);
                if (!inBadge && !inPopover) toggleUsersListUI(false);
            });
        }

        if (navBarBadgeEl) {
            const rect = navBarBadgeEl.getBoundingClientRect();
            usersPopoverEl.style.top = (rect.bottom + 6) + 'px';
            usersPopoverEl.style.right = (window.innerWidth - rect.right) + 'px';
        }

        usersPopoverEl.style.display = 'flex';
        renderUsersList();
    }

    function renderUsersList() {
        if (!usersPopoverEl || !room) return;
        const others = room.getOthers();
        const total = others.length + 1;
        const now = Date.now();

        let usersHTML = `
            <div style="padding:10px 14px; background:#1e202c; border-bottom:1px solid rgba(255,255,255,0.1); display:flex; justify-content:space-between; align-items:center;">
                <span style="font-size:12.5px; font-weight:600; color:#fff; display:flex; align-items:center; gap:6px;">
                    ${ICONS.users} Thành viên trong phòng (${total})
                </span>
                <div id="collab-users-close-btn" style="cursor:pointer; color:#858ca0;">${ICONS.close}</div>
            </div>

            <div style="padding:8px 12px; background:rgba(0,0,0,0.22); border-bottom:1px solid rgba(255,255,255,0.08); display:flex; align-items:center; justify-content:space-between;">
                <span style="font-size:12px; color:#a1aabf;">Mã: <strong style="color:#4C97FF;">${currentRoomId}</strong></span>
                <button id="collab-popover-copy-btn" style="
                    background: #4C97FF; border:none; border-radius:4px; padding:4px 8px;
                    color:#fff; font-size:11px; font-weight:600; cursor:pointer; display:flex; align-items:center; gap:4px;
                "><span class="collab-copy-btn-icon">${ICONS.copy}</span> Sao chép</button>
            </div>

            <div style="max-height:230px; overflow-y:auto; padding:6px 0;">
                <div style="display:flex; align-items:center; justify-content:space-between; padding:7px 14px; border-bottom:1px solid rgba(255,255,255,0.04);">
                    <div style="display:flex; align-items:center; gap:8px;">
                        <span style="width:7px; height:7px; border-radius:50%; background:#2fd67c;"></span>
                        <div style="display:flex; flex-direction:column;">
                            <span style="font-size:12px; color:#fff; font-weight:600;">${myUserName} <span style="color:#4C97FF; font-size:11px; font-weight:normal;">(Bạn)</span></span>
                            <span style="font-size:10px; color:#858ca0;">Đang kết nối</span>
                        </div>
                    </div>
                </div>
        `;

        others.forEach(user => {
            const p = user.presence;
            const name = p?.name || `Người dùng #${user.connectionId}`;
            let statusText = 'Đang hoạt động';
            if (p?.editingCostume && (now - p.editingCostume.timestamp < 10000)) {
                statusText = `Đang vẽ: [${p.editingCostume.spriteKey}]`;
            }

            usersHTML += `
                <div style="display:flex; align-items:center; justify-content:space-between; padding:7px 14px; border-bottom:1px solid rgba(255,255,255,0.04);">
                    <div style="display:flex; align-items:center; gap:8px;">
                        <span style="width:7px; height:7px; border-radius:50%; background:#2fd67c;"></span>
                        <div style="display:flex; flex-direction:column;">
                            <span style="font-size:12px; color:#e2e8f0; font-weight:500;">${name}</span>
                            <span style="font-size:10px; color:${p?.editingCostume ? '#ff7875' : '#858ca0'};">${statusText}</span>
                        </div>
                    </div>
                </div>
            `;
        });

        usersHTML += `</div>`;
        usersPopoverEl.innerHTML = usersHTML;

        const closeBtn = usersPopoverEl.querySelector('#collab-users-close-btn');
        if (closeBtn) closeBtn.onclick = () => toggleUsersListUI(false);

        const copyBtn = usersPopoverEl.querySelector('#collab-popover-copy-btn');
        if (copyBtn) copyBtn.onclick = copyRoomIdToClipboard;
    }

    function destroyUsersUI() {
        if (usersPopoverEl) { usersPopoverEl.remove(); usersPopoverEl = null; }
        isUsersListOpen = false;
    }

    function updateNavBarBadge(roomId, onlineCount = 1) {
        const navBar = document.querySelector('[class*="menu-bar_account-info-group"]') ||
                       document.querySelector('[class*="menu-bar_main-menu"]');
        if (!navBar) return;

        if (!navBarBadgeEl) {
            navBarBadgeEl = document.createElement('div');
            navBarBadgeEl.id = 'collab-navbar-badge';
            navBar.prepend(navBarBadgeEl);
        }

        if (!roomId) {
            navBarBadgeEl.style.cssText = `
                display: inline-flex; align-items: center; gap: 6px;
                background: #4C97FF; padding: 4px 12px; border-radius: 5px; color: #ffffff;
                font-size: 12px; font-weight: 600; cursor: pointer; user-select: none; margin: 0 6px;
            `;
            navBarBadgeEl.innerHTML = `<span>Kết nối phòng</span>`;
            navBarBadgeEl.onclick = () => {
                if (window.collabInstance) window.collabInstance.openModalBlock();
            };
            return;
        }

        navBarBadgeEl.style.cssText = `
            display: inline-flex; align-items: center; gap: 8px;
            background: #252839; border: 1px solid rgba(255,255,255,0.15);
            padding: 3px 10px; border-radius: 5px; color: #ffffff;
            font-size: 12px; font-weight: 500; user-select: none; margin: 0 6px;
        `;
        navBarBadgeEl.innerHTML = `
            <span id="collab-badge-users-btn" style="display:inline-flex; align-items:center; gap:5px; cursor:pointer; color:#2fd67c; font-weight:600;" title="Danh sách thành viên">
                ${ICONS.users} <span>${onlineCount}</span>
            </span>
            <span style="color:rgba(255,255,255,0.2);">|</span>
            <span id="collab-badge-leave-btn" style="display:inline-flex; align-items:center; cursor:pointer; color:#ff4d4f;" title="Rời khỏi phòng">
                ${ICONS.exit}
            </span>
        `;
        navBarBadgeEl.onclick = null;

        const usersBtn = navBarBadgeEl.querySelector('#collab-badge-users-btn');
        if (usersBtn) usersBtn.onclick = (e) => { e.stopPropagation(); toggleUsersListUI(); };

        const leaveBtn = navBarBadgeEl.querySelector('#collab-badge-leave-btn');
        if (leaveBtn) {
            leaveBtn.onclick = (e) => {
                e.stopPropagation();
                if (confirm('Bạn có chắc muốn rời khỏi phòng?')) leaveCollabRoom();
            };
        }
    }

    function openCollabJoinModal(defaultRoomId = 'phong-test-1') {
        return new Promise((resolve) => {
            const oldModal = document.getElementById('collab-modal-overlay');
            if (oldModal) oldModal.remove();

            const overlay = document.createElement('div');
            overlay.id = 'collab-modal-overlay';
            overlay.style.cssText = `
                position: fixed; inset: 0; background: rgba(0, 0, 0, 0.65);
                z-index: 10000001; display: flex; align-items: center; justify-content: center;
                font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
            `;

            overlay.innerHTML = `
                <div style="background: #252839; border: 1px solid rgba(255, 255, 255, 0.15); border-radius: 8px; width: 360px; padding: 22px; color: #fff;">
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 16px;">
                        <div style="display:flex; align-items:center; gap:8px;">
                            <img src="${DANV_LOGO_URL}" style="height: 22px; width: auto;" alt="DANV" />
                            <span style="font-size: 15px; font-weight: 600;">Không Gian Cộng Tác</span>
                        </div>
                        <div id="collab-modal-close" style="cursor:pointer; color:#858ca0;">${ICONS.close}</div>
                    </div>
                    <div style="margin-bottom: 14px;">
                        <label style="display: block; font-size: 12px; color: #b8bfd3; margin-bottom: 5px;">Tên hiển thị</label>
                        <input id="collab-input-name" type="text" value="${myUserName}" style="width: 100%; box-sizing: border-box; background: #1b1d28; border: 1px solid rgba(255,255,255,0.2); border-radius: 5px; padding: 8px 12px; color: #fff; font-size: 13px; outline: none;" />
                    </div>
                    <div style="margin-bottom: 20px;">
                        <label style="display: block; font-size: 12px; color: #b8bfd3; margin-bottom: 5px;">Mã phòng</label>
                        <input id="collab-input-room" type="text" value="${defaultRoomId}" style="width: 100%; box-sizing: border-box; background: #1b1d28; border: 1px solid rgba(255,255,255,0.2); border-radius: 5px; padding: 8px 12px; color: #4C97FF; font-weight: 600; font-size: 13px; outline: none;" />
                    </div>
                    <div style="display: flex; gap: 8px; justify-content: flex-end;">
                        <button id="collab-btn-cancel" style="background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.15); padding: 7px 16px; border-radius: 5px; color: #fff; font-size: 12px; cursor: pointer;">Hủy</button>
                        <button id="collab-btn-confirm" style="background: #4C97FF; border: none; padding: 7px 18px; border-radius: 5px; color: #fff; font-size: 12px; font-weight: 600; cursor: pointer;">Tham gia</button>
                    </div>
                </div>
            `;

            document.body.appendChild(overlay);
            const inputName = overlay.querySelector('#collab-input-name');
            const inputRoom = overlay.querySelector('#collab-input-room');

            overlay.querySelector('#collab-modal-close').onclick = () => { overlay.remove(); resolve(null); };
            overlay.querySelector('#collab-btn-cancel').onclick = () => { overlay.remove(); resolve(null); };

            const confirmAction = () => {
                const nameVal = inputName.value.trim() || myUserName;
                const roomVal = inputRoom.value.trim() || defaultRoomId;
                myUserName = nameVal;
                localStorage.setItem('collab_username', nameVal);
                overlay.remove();
                resolve({ roomId: roomVal, userName: nameVal });
            };

            overlay.querySelector('#collab-btn-confirm').onclick = confirmAction;
            inputRoom.onkeydown = (e) => { if (e.key === 'Enter') confirmAction(); };
        });
    }

    // --- HỆ THỐNG CHAT DRAWER ---
    let chatDrawerEl = null;
    let chatToggleBtnEl = null;
    let chatMessages = [];
    let isChatOpen = false;
    let unreadCount = 0;

    function setupChatUI() {
        if (!chatToggleBtnEl) {
            chatToggleBtnEl = document.createElement('div');
            chatToggleBtnEl.id = 'collab-chat-toggle-btn';
            chatToggleBtnEl.style.cssText = `
                position: fixed; bottom: 20px; right: 20px; width: 44px; height: 44px; border-radius: 50%;
                background: #4C97FF; color: #fff; display: flex; align-items: center; justify-content: center;
                cursor: pointer; z-index: 999998; box-shadow: 0 4px 14px rgba(0,0,0,0.3);
            `;
            chatToggleBtnEl.innerHTML = `
                ${ICONS.chat}
                <span id="collab-chat-unread" style="display: none; position: absolute; top: -3px; right: -3px; background: #ff4d4f; color: #fff; border-radius: 10px; padding: 1px 5px; font-size: 10px; font-weight: bold;">0</span>
            `;
            chatToggleBtnEl.onclick = () => toggleChatUI();
            document.body.appendChild(chatToggleBtnEl);
        }

        if (!chatDrawerEl) {
            chatDrawerEl = document.createElement('div');
            chatDrawerEl.id = 'collab-chat-drawer';
            chatDrawerEl.style.cssText = `
                position: fixed; bottom: 74px; right: 20px; width: 310px; height: 380px;
                background: #252839; border: 1px solid rgba(255,255,255,0.15); border-radius: 8px;
                box-shadow: 0 8px 30px rgba(0,0,0,0.45); display: none; flex-direction: column; z-index: 999998;
                font-family: "Helvetica Neue", Helvetica, Arial, sans-serif; overflow: hidden;
            `;

            chatDrawerEl.innerHTML = `
                <div style="background:#1e202c; padding:10px 14px; border-bottom:1px solid rgba(255,255,255,0.1); display:flex; justify-content:space-between; align-items:center;">
                    <span style="font-size:13px; font-weight:600; color:#fff; display:flex; align-items:center; gap:6px;">${ICONS.chat} Trò chuyện</span>
                    <div id="collab-chat-close-btn" style="cursor:pointer; color:#858ca0;">${ICONS.close}</div>
                </div>
                <div id="collab-chat-messages" style="flex:1; overflow-y:auto; padding:12px; display:flex; flex-direction:column; gap:8px;"></div>
                <div style="padding:8px 10px; background:#1e202c; border-top:1px solid rgba(255,255,255,0.1); display:flex; gap:6px;">
                    <input id="collab-chat-input" type="text" placeholder="Nhập tin nhắn..." style="flex:1; background:#141620; border:1px solid rgba(255,255,255,0.15); border-radius:4px; padding:6px 10px; color:#fff; font-size:12px; outline:none;" />
                    <button id="collab-chat-send-btn" style="background:#4C97FF; border:none; border-radius:4px; padding:6px 10px; color:#fff; cursor:pointer;">${ICONS.send}</button>
                </div>
            `;

            document.body.appendChild(chatDrawerEl);
            const inputEl = chatDrawerEl.querySelector('#collab-chat-input');
            const sendBtn = chatDrawerEl.querySelector('#collab-chat-send-btn');
            const closeBtn = chatDrawerEl.querySelector('#collab-chat-close-btn');

            closeBtn.onclick = () => toggleChatUI(false);
            const triggerSend = () => {
                const text = inputEl.value.trim();
                if (!text || !room) return;
                inputEl.value = '';
                broadcastChatMessage(text);
            };
            sendBtn.onclick = triggerSend;
            inputEl.onkeydown = (e) => { if (e.key === 'Enter') triggerSend(); };
        }
    }

    function toggleChatUI(forceState) {
        isChatOpen = (typeof forceState === 'boolean') ? forceState : !isChatOpen;
        if (!chatDrawerEl) return;
        chatDrawerEl.style.display = isChatOpen ? 'flex' : 'none';
        if (isChatOpen) {
            unreadCount = 0;
            const badge = document.getElementById('collab-chat-unread');
            if (badge) badge.style.display = 'none';
            const msgBox = chatDrawerEl.querySelector('#collab-chat-messages');
            if (msgBox) msgBox.scrollTop = msgBox.scrollHeight;
            const inp = chatDrawerEl.querySelector('#collab-chat-input');
            if (inp) inp.focus();
        }
    }

    function broadcastChatMessage(text) {
        if (!room) return;
        const msg = { type: 'CHAT_MESSAGE', sender: myUserName, text: text, time: Date.now() };
        room.broadcastEvent(msg);
        appendChatMessage(msg);
    }

    function appendChatMessage(msg) {
        chatMessages.push(msg);
        if (chatMessages.length > 100) chatMessages.shift();

        if (!isChatOpen) {
            unreadCount++;
            const badge = document.getElementById('collab-chat-unread');
            if (badge) {
                badge.textContent = unreadCount > 9 ? '9+' : unreadCount;
                badge.style.display = 'inline-block';
            }
        }

        const msgBox = document.getElementById('collab-chat-messages');
        if (!msgBox) return;

        const escapeSafeHTML = (str) => String(str || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');

        const isMe = msg.sender === myUserName;
        const timeStr = new Date(msg.time || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const row = document.createElement('div');
        row.style.cssText = `display: flex; flex-direction: column; align-items: ${isMe ? 'flex-end' : 'flex-start'};`;
        row.innerHTML = `
            <span style="font-size: 10.5px; color: #858ca0; margin-bottom: 2px;">${isMe ? 'Bạn' : escapeSafeHTML(msg.sender)} • ${timeStr}</span>
            <div style="background: ${isMe ? '#4C97FF' : '#33374b'}; color: #fff; padding: 6px 10px; border-radius: 6px; font-size: 12px; max-width: 80%; word-break: break-word;">${escapeSafeHTML(msg.text)}</div>
        `;
        msgBox.appendChild(row);
        msgBox.scrollTop = msgBox.scrollHeight;
    }

    function destroyChatUI() {
        if (chatDrawerEl) { chatDrawerEl.remove(); chatDrawerEl = null; }
        if (chatToggleBtnEl) { chatToggleBtnEl.remove(); chatToggleBtnEl = null; }
        chatMessages = [];
        isChatOpen = false;
        unreadCount = 0;
    }

    function leaveCollabRoom() {
        if (!room) return;
        try {
            releaseCostumeLock();
            client.leave(currentRoomId);
        } catch (e) {}

        room = null;
        currentRoomId = null;
        remoteOpDepth = 0;
        handledActionIds.clear();

        hideLoadingScreen();
        updateNavBarBadge(null);
        destroyChatUI();
        destroyUsersUI();

        for (const [id, el] of cursorElements) el.remove();
        cursorElements.clear();

        updateDOMCostumeCurtain(false);
        hideCostumeLock();

        showCostumeLock('Đã rời khỏi phòng');
        setTimeout(() => hideCostumeLock(), 2500);
    }

    // --- KHÓA VẼ TRANG PHỤC ---
    function getOtherCostumeEditor(spriteKey, costumeIndex) {
        if (!room) return null;
        const others = room.getOthers();
        const now = Date.now();
        for (const user of others) {
            const lock = user.presence?.editingCostume;
            if (lock && lock.spriteKey === spriteKey && (now - lock.timestamp < 10000)) {
                if (lock.costumeIndex === undefined || lock.costumeIndex === costumeIndex) {
                    return {
                        connectionId: user.connectionId,
                        userName: user.presence?.name || `Người dùng #${user.connectionId}`
                    };
                }
            }
        }
        return null;
    }

    function acquireCostumeLock(spriteKey, costumeIndex) {
        if (!room) return;
        room.updatePresence({
            editingCostume: { spriteKey: spriteKey, costumeIndex: costumeIndex, timestamp: Date.now() }
        });
        if (activeCostumeLockTimeout) clearTimeout(activeCostumeLockTimeout);
        activeCostumeLockTimeout = setTimeout(() => releaseCostumeLock(), 8000);
    }

    function releaseCostumeLock() {
        if (activeCostumeLockTimeout) { clearTimeout(activeCostumeLockTimeout); activeCostumeLockTimeout = null; }
        if (room) {
            room.updatePresence({ editingCostume: null });
            if (!isApplyingRemote) scheduleCloudflareSave(300, true);
        }
    }

    let paintCurtainEl = null;
    function updateDOMCostumeCurtain(isLocked, editorName) {
        if (!isLocked || !isCostumeTabActive()) {
            if (paintCurtainEl) paintCurtainEl.style.display = 'none';
            return;
        }

        const paintEditor = document.querySelector('[class*="paint-editor_paint-editor"]') 
                         || document.querySelector('[class*="paint-editor_canvas-container"]');
        if (!paintEditor || paintEditor.offsetParent === null) {
            if (paintCurtainEl) paintCurtainEl.style.display = 'none';
            return;
        }

        if (!paintCurtainEl) {
            paintCurtainEl = document.createElement('div');
            paintCurtainEl.id = 'collab-paint-curtain';
            document.body.appendChild(paintCurtainEl);
        }

        const rect = paintEditor.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) {
            paintCurtainEl.style.display = 'none';
            return;
        }

        paintCurtainEl.style.cssText = `
            position: fixed; top: ${rect.top}px; left: ${rect.left}px;
            width: ${rect.width}px; height: ${rect.height}px;
            background: rgba(20, 22, 33, 0.75); z-index: 99999;
            display: flex; align-items: center; justify-content: center;
            color: white; cursor: not-allowed; user-select: none;
            font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
        `;
        paintCurtainEl.innerHTML = `
            <div style="background: #252839; padding: 20px 28px; border-radius: 8px; border: 1px solid rgba(255, 77, 79, 0.4); text-align: center; max-width: 320px;">
                <div style="display:flex; justify-content:center; margin-bottom:8px;">${ICONS.lock}</div>
                <div style="font-size: 14px; font-weight: 600; color: #ff7875; margin-bottom: 6px;">Khu vực vẽ đang bị khóa</div>
                <div style="font-size: 12.5px; color: #e2e8f0; line-height: 1.4;"><strong style="color:#4C97FF;">${editorName}</strong> đang trực tiếp chỉnh sửa trang phục này.</div>
            </div>
        `;
    }

    let lockOverlay = null;
    function showCostumeLock(message) {
        if (!lockOverlay) {
            lockOverlay = document.createElement('div');
            lockOverlay.id = 'collab-costume-lock-banner';
            lockOverlay.style.cssText = `
                position: fixed; bottom: 74px; right: 24px;
                background: #252839; color: #f8fafc; padding: 10px 16px; border-radius: 6px;
                font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
                box-shadow: 0 6px 20px rgba(0,0,0,0.35); border: 1px solid rgba(255,255,255,0.12);
                z-index: 1000000; font-size: 12.5px; pointer-events: none; transition: opacity 0.2s;
            `;
            document.body.appendChild(lockOverlay);
        }
        lockOverlay.innerHTML = `<span>${message}</span>`;
        lockOverlay.style.opacity = '1';
    }

    function hideCostumeLock() {
        if (lockOverlay) lockOverlay.style.opacity = '0';
    }

    function setupCostumeInteractionListeners() {
        const handleInteraction = (e) => {
            if (!room || isApplyingRemote) return;
            const target = Scratch.vm.editingTarget;
            if (!target) return;
            const inPaintArea = e.target.closest && (e.target.closest('[class*="paint-editor_"]') || e.target.closest('[class*="asset-panel_"]'));
            if (!inPaintArea) return;

            const syncKey = getSyncKey(target);
            const costumeIndex = target.currentCostume;
            const otherEditor = getOtherCostumeEditor(syncKey, costumeIndex);
            if (otherEditor) {
                e.stopPropagation();
                e.preventDefault();
                updateDOMCostumeCurtain(true, otherEditor.userName);
                return;
            }
            acquireCostumeLock(syncKey, costumeIndex);
        };

        window.addEventListener('pointerdown', handleInteraction, true);
        window.addEventListener('keydown', handleInteraction, true);

        document.addEventListener('click', () => {
            setTimeout(() => {
                if (!isCostumeTabActive()) {
                    if (paintCurtainEl) paintCurtainEl.style.display = 'none';
                    if (!isCostumeLocked) hideCostumeLock();
                }
            }, 60);
        }, true);
    }

    function setupDOM() {
        if (!cursorsContainer) {
            cursorsContainer = document.createElement('div');
            cursorsContainer.id = 'liveblocks-cursors';
            Object.assign(cursorsContainer.style, {
                position: 'absolute', top: '0', left: '0', width: '100vw', height: '100vh',
                pointerEvents: 'none', zIndex: '999999'
            });
            document.body.appendChild(cursorsContainer);
        }
    }

    function getUserColor(id) {
        const colors = ['#4C97FF', '#FF6680', '#FFAB19', '#59C059', '#9966FF', '#FF8C1A', '#4CBFE6', '#FF5959'];
        return colors[Math.abs(id) % colors.length];
    }

    function createCursorElement(connectionId) {
        const color = getUserColor(connectionId);
        const el = document.createElement('div');
        el.style.cssText = `position: absolute; left: 0; top: 0; pointer-events: none; z-index: 999999;`;
        const dot = document.createElement('div');
        dot.style.cssText = `position: absolute; width: 13px; height: 13px; background: ${color}; border: 2px solid #fff; border-radius: 50%; transform: translate(-50%, -50%);`;
        const label = document.createElement('div');
        label.className = 'collab-cursor-name';
        label.style.cssText = `position: absolute; left: 10px; top: 8px; background: ${color}; color: #fff; font-size: 11px; font-weight: 600; padding: 3px 7px; border-radius: 4px; white-space: nowrap;`;
        el.appendChild(dot);
        el.appendChild(label);
        return el;
    }

    function getSyncKey(target) {
        return target.isStage ? "_STAGE_" : target.sprite.name;
    }

    function getTargetBySyncKey(key) {
        return Scratch.vm.runtime.targets.find(t => key === "_STAGE_" ? t.isStage : t.sprite.name === key);
    }

    function applyBlocksToTarget(target, data, incomingVersion = 0) {
        if (!data || !target || !target.blocks) return false;
        const blocksJSON = (data.blocks !== undefined) ? data.blocks : data;
        const commentsJSON = (data.comments !== undefined) ? data.comments : null;

        try {
            target.blocks._blocks = blocksJSON;
            if (commentsJSON !== null) target.blocks._comments = commentsJSON;
            const scripts = [];
            for (const id in blocksJSON) {
                if (blocksJSON[id].topLevel) scripts.push(id);
            }
            target.blocks._scripts = scripts;
            if (typeof target.blocks.resetCache === 'function') target.blocks.resetCache();
            return true;
        } catch (err) {
            console.error("[Collab] Lỗi áp dụng blocks:", err);
            return false;
        }
    }

    // --- HOOKS VÀO SCRATCH VM ---
    function setupSpriteHooks() {
        if (Scratch.vm._hasCollabSpriteHooks) return;
        Scratch.vm._hasCollabSpriteHooks = true;
        const stage = Scratch.vm.runtime.targets[0];
        const targetProto = Object.getPrototypeOf(stage);

        const originalSetXY = targetProto.setXY;
        targetProto.setXY = function(x, y, force) {
            originalSetXY.call(this, x, y, force);
            if (!isApplyingRemote && room && this.isOriginal) {
                const now = Date.now();
                if (now - (this._lastXYSync || 0) > 40) {
                    this._lastXYSync = now;
                    room.broadcastEvent({ type: 'SYNC_SPRITE_PROP', spriteKey: getSyncKey(this), prop: 'xy', value: { x: this.x, y: this.y } });
                }
            }
        };

        const originalSetSize = targetProto.setSize;
        targetProto.setSize = function(size) {
            originalSetSize.call(this, size);
            if (!isApplyingRemote && room && this.isOriginal) {
                room.broadcastEvent({ type: 'SYNC_SPRITE_PROP', spriteKey: getSyncKey(this), prop: 'size', value: this.size });
                scheduleCloudflareSave(3000);
            }
        };

        const originalSetDirection = targetProto.setDirection;
        targetProto.setDirection = function(dir) {
            originalSetDirection.call(this, dir);
            if (!isApplyingRemote && room && this.isOriginal) {
                room.broadcastEvent({ type: 'SYNC_SPRITE_PROP', spriteKey: getSyncKey(this), prop: 'direction', value: this.direction });
                scheduleCloudflareSave(3000);
            }
        };

        const originalSetCostume = targetProto.setCostume;
        targetProto.setCostume = function(index) {
            originalSetCostume.call(this, index);
            if (!isApplyingRemote && room && this.isOriginal) {
                room.broadcastEvent({ type: 'SYNC_SPRITE_PROP', spriteKey: getSyncKey(this), prop: 'costume', value: this.currentCostume });
                scheduleCloudflareSave(3000);
            }
        };

        const originalAddCostume = targetProto.addCostume;
        targetProto.addCostume = function(costume, optIndex) {
            const result = originalAddCostume.call(this, costume, optIndex);
            if (!isApplyingRemote && room) scheduleCloudflareSave(800, true);
            return result;
        };

        if (targetProto.deleteCostume) {
            const originalDeleteCostume = targetProto.deleteCostume;
            targetProto.deleteCostume = function(index) {
                const result = originalDeleteCostume.call(this, index);
                if (!isApplyingRemote && room) scheduleCloudflareSave(800, true);
                return result;
            };
        }
    }

    function setupVMHooks() {
        if (Scratch.vm._hasCollabVMHooks) return;
        Scratch.vm._hasCollabVMHooks = true;
        const stage = Scratch.vm.runtime.targets[0];
        const blockContainerProto = Object.getPrototypeOf(stage.blocks);
        const originalBlocklyListen = blockContainerProto.blocklyListen;

        blockContainerProto.blocklyListen = function(e) {
            originalBlocklyListen.call(this, e);
            if (isRemoteActive() || !room) return;
            if (e.isRemote || e.type === 'ui') return;

            const SYNC_EVENTS = ['create', 'delete', 'move', 'change', 'comment_create', 'comment_change', 'comment_move', 'comment_delete'];
            if (SYNC_EVENTS.includes(e.type)) {
                let target = null;
                for (const t of Scratch.vm.runtime.targets) {
                    if (t.blocks === this) { target = t; break; }
                }
                if (!target) return;

                const syncKey = getSyncKey(target);
                const blocksRef = this._blocks;
                const commentsRef = this._comments;

                if (blockSyncDebounceTimers.has(syncKey)) clearTimeout(blockSyncDebounceTimers.get(syncKey));
                blockSyncDebounceTimers.set(syncKey, setTimeout(() => {
                    blockSyncDebounceTimers.delete(syncKey);
                    if (!room || isRemoteActive()) return;

                    const newVersion = (spriteVersions.get(syncKey) || 0) + 1;
                    spriteVersions.set(syncKey, newVersion);

                    const payloadString = JSON.stringify({ blocks: blocksRef, comments: commentsRef, version: newVersion });
                    if (sharedBlocks) sharedBlocks.set(syncKey, payloadString);
                    room.broadcastEvent({ type: 'INSTANT_BLOCK_SYNC', spriteKey: syncKey, data: payloadString });
                    scheduleCloudflareSave(3000);
                }, 90));
            }
        };

        // BẮT SỰ KIỆN TẠO SPRITE MỚI
        const originalAddSprite = Scratch.vm.addSprite;
        Scratch.vm.addSprite = async function(input) {
            const result = await originalAddSprite.call(this, input);
            if (!isRemoteActive() && room) {
                scheduleCloudflareSave(300, true);
            }
            return result;
        };

        // BẮT SỰ KIỆN NHÂN BẢN SPRITE
        const originalDuplicateSprite = Scratch.vm.duplicateSprite;
        Scratch.vm.duplicateSprite = async function(targetId) {
            const result = await originalDuplicateSprite.call(this, targetId);
            if (!isRemoteActive() && room) {
                scheduleCloudflareSave(300, true);
            }
            return result;
        };

        // BẮT SỰ KIỆN XÓA SPRITE
        const originalDeleteSprite = Scratch.vm.deleteSprite;
        Scratch.vm.deleteSprite = function(targetId) {
            const result = originalDeleteSprite.call(this, targetId);
            if (!isRemoteActive() && room) {
                scheduleCloudflareSave(300, true);
            }
            return result;
        };

        // BẮT SỰ KIỆN VẼ / CHỈNH SỬA TRANG PHỤC VECTOR (SVG)
        if (Scratch.vm.updateSvg) {
            const originalUpdateSvg = Scratch.vm.updateSvg;
            Scratch.vm.updateSvg = function(costumeIndex, svgText, rotationCenterX, rotationCenterY) {
                const result = originalUpdateSvg.call(this, costumeIndex, svgText, rotationCenterX, rotationCenterY);
                if (!isRemoteActive() && room) {
                    scheduleCloudflareSave(1000, true);
                }
                return result;
            };
        }

        // BẮT SỰ KIỆN VẼ / CHỈNH SỬA TRANG PHỤC BITMAP
        if (Scratch.vm.updateBitmap) {
            const originalUpdateBitmap = Scratch.vm.updateBitmap;
            Scratch.vm.updateBitmap = function(costumeIndex, bitmap, rotationCenterX, rotationCenterY, bitmapResolution) {
                const result = originalUpdateBitmap.call(this, costumeIndex, bitmap, rotationCenterX, rotationCenterY, bitmapResolution);
                if (!isRemoteActive() && room) {
                    scheduleCloudflareSave(1000, true);
                }
                return result;
            };
        }

        // BẮT SỰ KIỆN ĐỔI TÊN TRANG PHỤC
        if (Scratch.vm.renameCostume) {
            const originalRenameCostume = Scratch.vm.renameCostume;
            Scratch.vm.renameCostume = function(costumeIndex, newName) {
                const result = originalRenameCostume.call(this, costumeIndex, newName);
                if (!isRemoteActive() && room) {
                    scheduleCloudflareSave(800, true);
                }
                return result;
            };
        }

        // BẮT SỰ KIỆN THAY ĐỔI THỨ TỰ TRANG PHỤC
        if (Scratch.vm.reorderCostume) {
            const originalReorderCostume = Scratch.vm.reorderCostume;
            Scratch.vm.reorderCostume = function(costumeIndex, newIndex) {
                const result = originalReorderCostume.call(this, costumeIndex, newIndex);
                if (!isRemoteActive() && room) {
                    scheduleCloudflareSave(800, true);
                }
                return result;
            };
        }

        // BẮT SỰ KIỆN NẠP DỰ ÁN MỚI TỪ MÁY TÍNH (.SB3)
        const originalLoadProject = Scratch.vm.loadProject;
        Scratch.vm.loadProject = async function(input) {
            showLoadingScreen('Đang xử lý dự án...', 'Hệ thống đang phân tích cấu trúc tệp dữ liệu...', 30);
            const result = await originalLoadProject.call(this, input);
            if (!isRemoteActive() && room) {
                try {
                    updateLoadingProgress('Đang đồng bộ...', 'Đang thiết lập tiến trình đẩy tài nguyên lên máy chủ...', 50);
                    for (const t of Scratch.vm.runtime.targets) {
                        await syncTargetAssetsToR2(t);
                    }
                    updateLoadingProgress('Đang thiết lập...', 'Khởi tạo cấu trúc môi trường cho các thành viên...', 80);
                    const snapshot = packCurrentProject();
                    await fetch(`${CLOUDFLARE_URL}/project?room=${encodeURIComponent(currentRoomId)}`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(snapshot)
                    });
                    console.log("[DANV Workspace ☁️] Hoàn tất đẩy dữ liệu cấu trúc dự án mới.");
                    room.broadcastEvent({ type: 'SYNC_CLOUD_REFRESH' });
                } catch (e) {
                    console.error("[DANV Workspace ❌] Lỗi cập nhật dự án:", e);
                } finally {
                    setTimeout(() => hideLoadingScreen(), 400);
                }
            } else {
                hideLoadingScreen();
            }
            return result;
        };
    }

    // --- LỚP ĐIỀU KHIỂN CHÍNH ---
    class LiveblocksCollab {
        constructor() {
            window.collabInstance = this;
            setTimeout(() => { updateNavBarBadge(null); }, 600);
        }

        getInfo() {
            return {
                id: 'liveblockscollab',
                name: 'Collaborative Coding',
                menuIconURI: 'https://github.com/danvPR/aftercode-cloud-engine/blob/main/other/colab-icon.png?raw=true',
                blockIconURI: 'https://github.com/danvPR/aftercode-cloud-engine/blob/main/other/colab-icon.png?raw=true',
                color1: '#4C97FF',
                color2: '#3373CC',
                color3: '#285bab',
                blocks: [
                    { blockType: Scratch.BlockType.BUTTON, text: 'Kết nối phòng', func: 'openModalBlock' },
                    { blockType: Scratch.BlockType.BUTTON, text: 'Thoát phòng', func: 'leaveRoomBlock' }
                ]
            };
        }

        async openModalBlock() {
            if (room) {
                alert(`Bạn đang ở trong phòng "${currentRoomId}". Hãy thoát phòng trước nếu muốn đổi!`);
                return;
            }
            const modalResult = await openCollabJoinModal('phong-test-1');
            if (modalResult) this.startRoomConnection(modalResult.roomId, modalResult.userName);
        }

        leaveRoomBlock() {
            if (!room) { alert('Bạn hiện chưa tham gia phòng nào!'); return; }
            leaveCollabRoom();
        }

        async startRoomConnection(roomId, userName) {
            if (room) return;
            currentRoomId = roomId;
            myUserName = userName;

            showLoadingScreen(`Truy cập phòng [${roomId}]`, 'Hệ thống đang khởi tạo giao thức làm việc...', 20);

            setupDOM();
            setupVMHooks();
            setupSpriteHooks();
            setupCostumeInteractionListeners();
            updateNavBarBadge(roomId, 1);
            setupChatUI();

            try {
                // 1. TẢI DỰ ÁN TỪ MÁY CHỦ TRUNG TÂM (NẾU ĐÃ CÓ BẢN LƯU)
                const restored = await restoreProjectFromCloudflare(roomId);
                if (!restored) {
                    console.log("[DANV Workspace ☁️] Khởi tạo không gian làm việc mới. Bắt đầu thiết lập điểm khôi phục gốc...");
                    scheduleCloudflareSave(500);
                }

                // 2. THIẾT LẬP KÊNH THỜI GIAN THỰC (ĐỒNG BỘ CHUỘT, NHẮN TIN, BẢO MẬT TÀI NGUYÊN)
                const response = client.enterRoom(roomId, {
                    initialPresence: { cursor: null, editingCostume: null, name: myUserName },
                    initialStorage: { sharedBlocks: new LiveMap() }
                });
                room = response.room;

                document.addEventListener('mousemove', (e) => {
                    if (Date.now() - lastMouseTime > 50 && room) {
                        const relX = e.clientX / Math.max(1, window.innerWidth);
                        const relY = e.clientY / Math.max(1, window.innerHeight);
                        room.updatePresence({ cursor: { x: relX, y: relY }, name: myUserName });
                        lastMouseTime = Date.now();
                    }
                });

                room.subscribe("others", () => {
                    const others = room.getOthers();
                    const activeIds = new Set();
                    let someoneEditingCurrentCostume = false;
                    let currentEditorName = "Người dùng khác";

                    updateNavBarBadge(currentRoomId, others.length + 1);
                    if (isUsersListOpen) renderUsersList();

                    const currentEditingTarget = Scratch.vm.editingTarget;
                    const currentSyncKey = currentEditingTarget ? getSyncKey(currentEditingTarget) : null;
                    const currentCostumeIdx = currentEditingTarget ? currentEditingTarget.currentCostume : -1;
                    const now = Date.now();

                    others.forEach(user => {
                        const p = user.presence;
                        if (p && p.cursor) {
                            const cid = user.connectionId;
                            activeIds.add(cid);
                            let el = cursorElements.get(cid);
                            if (!el) {
                                el = createCursorElement(cid);
                                cursorsContainer.appendChild(el);
                                cursorElements.set(cid, el);
                            }
                            const labelEl = el.querySelector('.collab-cursor-name');
                            if (labelEl) labelEl.textContent = p.name || `Người dùng #${cid}`;
                            const posX = (p.cursor.x <= 1 ? p.cursor.x * window.innerWidth : p.cursor.x);
                            const posY = (p.cursor.y <= 1 ? p.cursor.y * window.innerHeight : p.cursor.y);
                            el.style.left = posX + 'px';
                            el.style.top = posY + 'px';
                        }

                        if (p && p.editingCostume && (now - p.editingCostume.timestamp < 10000)) {
                            if (currentSyncKey && p.editingCostume.spriteKey === currentSyncKey) {
                                if (p.editingCostume.costumeIndex === undefined || p.editingCostume.costumeIndex === currentCostumeIdx) {
                                    someoneEditingCurrentCostume = true;
                                    currentEditorName = p.name || `Người dùng #${user.connectionId}`;
                                }
                            }
                        }
                    });

                    if (isCostumeTabActive()) {
                        updateDOMCostumeCurtain(someoneEditingCurrentCostume, currentEditorName);
                        if (someoneEditingCurrentCostume) showCostumeLock(`${currentEditorName} đang vẽ trang phục này...`);
                        else if (!isCostumeLocked) hideCostumeLock();
                    }

                    for (const [id, el] of cursorElements) {
                        if (!activeIds.has(id)) { el.remove(); cursorElements.delete(id); }
                    }
                });

                room.subscribe("event", ({ event }) => {
                    if (event.type === 'CHAT_MESSAGE') appendChatMessage(event);

                    if (event.type === 'SYNC_SPRITE_PROP') {
                        const target = getTargetBySyncKey(event.spriteKey);
                        if (target) {
                            isApplyingRemote = true;
                            try {
                                if (event.prop === 'xy') target.setXY(event.value.x, event.value.y);
                                if (event.prop === 'size') target.setSize(event.value);
                                if (event.prop === 'direction') target.setDirection(event.value);
                                if (event.prop === 'costume') target.setCostume(event.value);
                                Scratch.vm.emitTargetsUpdate();
                            } finally {
                                setTimeout(() => { isApplyingRemote = false; }, 40);
                            }
                        }
                    }

                    if (event.type === 'INSTANT_BLOCK_SYNC') {
                        const target = getTargetBySyncKey(event.spriteKey);
                        if (target) {
                            isApplyingRemote = true;
                            try {
                                const parsed = JSON.parse(event.data);
                                applyBlocksToTarget(target, parsed);
                                Scratch.vm.emitWorkspaceUpdate();
                            } finally {
                                setTimeout(() => { isApplyingRemote = false; }, 50);
                            }
                        }
                    }

                    if (event.type === 'SYNC_CLOUD_REFRESH') {
                        console.log("[DANV Workspace ☁️] Phát hiện sự kiện nạp dự án. Đang đồng bộ thay đổi...");
                        showLoadingScreen('Đang cập nhật thay đổi...', 'Hệ thống phát hiện tệp tin mới từ thành viên, đang tiến hành lấy dữ liệu...', 35);
                        restoreProjectFromCloudflare(currentRoomId).then(() => {
                            setTimeout(() => hideLoadingScreen(), 400);
                        });
                    }
                });

                room.getStorage().then((storage) => {
                    sharedBlocks = storage.root.get("sharedBlocks");
                    updateLoadingProgress('Hoàn tất!', 'Dự án đã sẵn sàng cộng tác!', 100);
                    setTimeout(() => hideLoadingScreen(), 300);
                });

            } catch (err) {
                console.error("[Collab ❌] Lỗi:", err);
                hideLoadingScreen();
            }
        }
    }

    Scratch.extensions.register(new LiveblocksCollab());
})(Scratch);