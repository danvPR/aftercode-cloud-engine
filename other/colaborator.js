(async function(Scratch) {
    'use strict';

    if (!Scratch.extensions.unsandboxed) {
        alert('LỖI: Liveblocks Collab bắt buộc phải chạy Unsandboxed!');
        return;
    }

    console.log("[Collab ⏳] Đang tải thư viện Liveblocks...");
    const { createClient, LiveMap } = await import('https://esm.sh/@liveblocks/client?bundle');

    const PUBLIC_API_KEY = "pk_dev_kA8Le_ojSQGAiMqwZu_gKFmMeznbD-5AN28BbxPYRaxYEIXUmc09Ewht7ylMt1JT"; 
    const client = createClient({ publicApiKey: PUBLIC_API_KEY });

    let room = null;
    let cursorsContainer = null;
    let cursorElements = new Map();
    let lastMouseTime = 0;

    let sharedBlocks = null; 
    let isApplyingRemote = false; // Chốt an toàn chống vòng lặp mạng (Echo)
    let isCostumeLocked = false;  // Khóa chống chỉnh sửa khi người khác đang truyền chunk
    const incomingTransfers = new Map(); // Bộ đệm chứa các mảnh dữ liệu đang nhận dở

    // --- 🛡️ HỆ THỐNG AN TOÀN CHỐNG MẤT DỮ LIỆU & KHÓA COSTUME ---
    const localBackups = new Map(); // Lưu snapshot dự phòng: spriteKey -> { blocks, comments, time }
    const spriteVersions = new Map(); // Theo dõi phiên bản: spriteKey -> versionNumber
    let activeCostumeLockTimeout = null;
    let liveCostumeSyncInterval = null; // Bộ lặp gửi hình ảnh mỗi 5s
    let lastSentCostumeDataURI = null; // Tránh gửi trùng lặp nếu chưa vẽ gì mới

    // Kiểm tra xem trang phục có đang bị người khác khóa chỉnh sửa hay không
    function getOtherCostumeEditor(spriteKey, costumeIndex) {
        if (!room) return null;
        const others = room.getOthers();
        const now = Date.now();
        for (const user of others) {
            const lock = user.presence?.editingCostume;
            // Khóa hợp lệ nếu còn hạn dưới 10 giây
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

    // Chiếm giữ quyền sửa trang phục & kích hoạt đồng bộ 5s cho người khác xem
    function acquireCostumeLock(spriteKey, costumeIndex) {
        if (!room) return;
        room.updatePresence({
            editingCostume: {
                spriteKey: spriteKey,
                costumeIndex: costumeIndex,
                timestamp: Date.now()
            }
        });

        // Kích hoạt bộ đếm tự động gửi hình ảnh mỗi 5 giây cho người khác
        if (!liveCostumeSyncInterval) {
            liveCostumeSyncInterval = setInterval(() => {
                sendLiveCostumeSync();
            }, 5000);
        }

        if (activeCostumeLockTimeout) clearTimeout(activeCostumeLockTimeout);
        // Tự động nhả khóa nếu không còn thao tác vẽ trong 8 giây
        activeCostumeLockTimeout = setTimeout(() => {
            releaseCostumeLock();
        }, 8000);
    }

    // Nhả quyền chỉnh sửa trang phục
    function releaseCostumeLock() {
        if (liveCostumeSyncInterval) {
            clearInterval(liveCostumeSyncInterval);
            liveCostumeSyncInterval = null;
        }
        if (activeCostumeLockTimeout) {
            clearTimeout(activeCostumeLockTimeout);
            activeCostumeLockTimeout = null;
        }
        lastSentCostumeDataURI = null;
        if (room) {
            room.updatePresence({ editingCostume: null });
        }
    }

    // Hàm gửi dữ liệu hình ảnh hiện tại mỗi 5 giây
    function sendLiveCostumeSync() {
        if (!room || isApplyingRemote) return;
        const target = Scratch.vm.editingTarget;
        if (!target || !target.sprite) return;
        const costumeIndex = target.currentCostume;
        const costume = target.sprite.costumes[costumeIndex];
        if (!costume) return;

        try {
            const costumeData = serializeCostume(costume);
            if (costumeData && costumeData.dataURI && costumeData.dataURI !== lastSentCostumeDataURI) {
                lastSentCostumeDataURI = costumeData.dataURI;
                sendChunkedPayload('SYNC_LIVE_COSTUME_PREVIEW', getSyncKey(target), {
                    costumeIndex: costumeIndex,
                    costumeData: costumeData
                });
            }
        } catch (e) {
            console.error("[Collab] Lỗi đồng bộ live costume 5s:", e);
        }
    }

    // TẤM MÀN CHẮN CHẶN CỨNG B KHÔNG CHO BẤM CHUỘT / VẼ VÀO PAINT EDITOR
    let paintCurtainEl = null;
    function updateDOMCostumeCurtain(isLocked, editorName) {
        const paintEditor = document.querySelector('[class*="paint-editor_paint-editor"]') 
                         || document.querySelector('[class*="paint-editor_canvas-container"]')
                         || document.querySelector('[class*="asset-panel_detail-area"]');

        if (!isLocked || !paintEditor) {
            if (paintCurtainEl) paintCurtainEl.style.display = 'none';
            return;
        }

        if (!paintCurtainEl) {
            paintCurtainEl = document.createElement('div');
            paintCurtainEl.id = 'collab-paint-curtain';
            paintCurtainEl.style.cssText = `
                position: absolute; top: 0; left: 0; width: 100%; height: 100%;
                background: rgba(15, 23, 42, 0.55); backdrop-filter: blur(2px);
                z-index: 99999; display: flex; flex-direction: column;
                align-items: center; justify-content: center; color: white;
                cursor: not-allowed; pointer-events: all; user-select: none;
                font-family: sans-serif;
            `;
            document.body.appendChild(paintCurtainEl);
        }

        const rect = paintEditor.getBoundingClientRect();
        paintCurtainEl.style.top = rect.top + 'px';
        paintCurtainEl.style.left = rect.left + 'px';
        paintCurtainEl.style.width = rect.width + 'px';
        paintCurtainEl.style.height = rect.height + 'px';
        paintCurtainEl.style.display = 'flex';
        paintCurtainEl.innerHTML = `
            <div style="background: rgba(18, 18, 24, 0.95); padding: 16px 24px; border-radius: 12px; border: 2px solid #ff3344; box-shadow: 0 10px 30px rgba(0,0,0,0.6); text-align: center; pointer-events: none;">
                <div style="font-size: 20px; font-weight: bold; margin-bottom: 8px;">🔒 CHẾ ĐỘ XEM TRỰC TIẾP</div>
                <div style="font-size: 14px; color: #ff9999;">${editorName} đang chỉnh sửa trang phục này!</div>
                <div style="font-size: 12px; color: #88ccff; margin-top: 6px;">⏳ Đang tự động nhận hình ảnh trực tiếp mỗi 5 giây...</div>
            </div>
        `;
    }

    // Giao diện thông báo nhỏ góc màn hình
    let lockOverlay = null;
    function showCostumeLock(message) {
        if (!lockOverlay) {
            lockOverlay = document.createElement('div');
            lockOverlay.id = 'collab-costume-lock-banner';
            lockOverlay.style.cssText = `
                position: fixed; bottom: 24px; right: 24px;
                background: rgba(20, 20, 28, 0.95); color: #fff;
                padding: 12px 18px; border-radius: 8px; font-family: sans-serif;
                box-shadow: 0 6px 20px rgba(0,0,0,0.4); z-index: 1000000;
                display: flex; align-items: center; gap: 10px; border-left: 4px solid #0055ff;
                font-size: 13px; pointer-events: none; transition: opacity 0.25s, transform 0.25s;
            `;
            document.body.appendChild(lockOverlay);
        }
        lockOverlay.innerHTML = `<span style="display:inline-block; font-size:16px;">⏳</span> <span>${message}</span>`;
        lockOverlay.style.opacity = '1';
        lockOverlay.style.transform = 'translateY(0)';
    }

    function hideCostumeLock() {
        if (lockOverlay) {
            lockOverlay.style.opacity = '0';
            lockOverlay.style.transform = 'translateY(10px)';
        }
    }

    // Bắt sự kiện người dùng click vào khu vực vẽ để chiếm quyền hoặc chặn nếu bị khóa
    function setupCostumeInteractionListeners() {
        const handleInteraction = (e) => {
            if (!room || isApplyingRemote) return;
            const target = Scratch.vm.editingTarget;
            if (!target) return;

            // Kiểm tra click có nằm trong tab trang phục hay Paint Editor không
            const inPaintArea = e.target.closest && (
                e.target.closest('[class*="paint-editor_"]') || 
                e.target.closest('[class*="asset-panel_"]')
            );
            if (!inPaintArea) return;

            const syncKey = getSyncKey(target);
            const costumeIndex = target.currentCostume;

            const otherEditor = getOtherCostumeEditor(syncKey, costumeIndex);
            if (otherEditor) {
                // Người khác đang vẽ: Chặn ngay lập tức
                e.stopPropagation();
                e.preventDefault();
                updateDOMCostumeCurtain(true, otherEditor.userName);
                return;
            }

            // Nếu chưa ai vẽ: Chiếm quyền khóa và tự động kích hoạt gửi mỗi 5s
            acquireCostumeLock(syncKey, costumeIndex);
        };

        window.addEventListener('pointerdown', handleInteraction, true);
        window.addEventListener('keydown', handleInteraction, true);
    }

    // Hàm chia nhỏ dữ liệu và truyền dần dần (Chunking Sender)
    async function sendChunkedPayload(actionType, spriteKey, payload) {
        if (!room) return;
        const jsonStr = JSON.stringify(payload);
        const CHUNK_SIZE = 32 * 1024; // 32 KB mỗi gói (Cực kỳ an toàn cho Liveblocks)
        const totalChunks = Math.ceil(jsonStr.length / CHUNK_SIZE);
        const transferId = 'tr_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);

        // Báo hiệu bắt đầu truyền để khóa máy bên kia
        room.broadcastEvent({
            type: 'TRANSFER_START',
            transferId: transferId,
            action: actionType,
            spriteKey: spriteKey
        });

        for (let i = 0; i < totalChunks; i++) {
            const chunk = jsonStr.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
            room.broadcastEvent({
                type: 'TRANSFER_CHUNK',
                transferId: transferId,
                index: i,
                total: totalChunks,
                chunk: chunk
            });
            // Nghỉ 15ms giữa mỗi gói để tránh bị chặn vì spam rate limit
            if (totalChunks > 1) {
                await new Promise(res => setTimeout(res, 15));
            }
        }
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

    function getSyncKey(target) {
        return target.isStage ? "_STAGE_" : target.sprite.name;
    }

    function getTargetBySyncKey(key) {
        return Scratch.vm.runtime.targets.find(t => 
            key === "_STAGE_" ? t.isStage : t.sprite.name === key
        );
    }

    // --- 🛠️ 1. HỖ TRỢ ĐỒNG BỘ CẢ KHỐI LỆNH, CHÚ THÍCH & BẢO VỆ CHỐNG XUNG ĐỘT ---
    function applyBlocksToTarget(target, data, incomingVersion = 0) {
        if (!data || !target || !target.blocks) return false;

        const syncKey = getSyncKey(target);

        // Kiểm tra phiên bản gói tin: Tránh gói tin trễ ghi đè lên phiên bản mới hơn
        const currentVersion = spriteVersions.get(syncKey) || 0;
        if (incomingVersion > 0 && incomingVersion < currentVersion) {
            console.warn(`[Collab ⚠️] Bỏ qua gói blocks cũ (Incoming: ${incomingVersion}, Hiện tại: ${currentVersion})`);
            return false;
        }

        const blocksJSON = (data.blocks !== undefined) ? data.blocks : data;
        const commentsJSON = (data.comments !== undefined) ? data.comments : null;

        // BẢO VỆ CHỐNG GHI ĐÈ RỖNG (Safe check chống mất code do lỗi truyền tin)
        const incomingBlockCount = blocksJSON ? Object.keys(blocksJSON).length : 0;
        const currentBlockCount = target.blocks._blocks ? Object.keys(target.blocks._blocks).length : 0;

        if (currentBlockCount > 5 && incomingBlockCount === 0 && !data.isExplicitClear) {
            console.error(`[Collab 🛑 CẢNH BÁO XUNG ĐỘT] Ngăn chặn xóa trắng ${currentBlockCount} khối lệnh nghi do lỗi mạng!`);
            return false;
        }

        // TẠO BẢN SAO LƯU AN TOÀN TRƯỚC KHI GHI ĐÈ (LOCAL SNAPSHOT)
        try {
            const backupSnapshot = {
                blocks: JSON.parse(JSON.stringify(target.blocks._blocks || {})),
                comments: JSON.parse(JSON.stringify(target.blocks._comments || {})),
                timestamp: Date.now()
            };
            localBackups.set(syncKey, backupSnapshot);
            // Lưu thêm 1 bản vào localStorage phòng trường hợp crash trình duyệt
            localStorage.setItem(`collab_backup_${syncKey}`, JSON.stringify(backupSnapshot));
        } catch (e) {
            console.warn("[Collab] Không thể tạo backup cục bộ:", e);
        }

        try {
            target.blocks._blocks = blocksJSON;
            if (commentsJSON !== null) {
                target.blocks._comments = commentsJSON;
            }

            const scripts = [];
            for (const id in blocksJSON) {
                if (blocksJSON[id].topLevel) scripts.push(id);
            }
            target.blocks._scripts = scripts;
            if (typeof target.blocks.resetCache === 'function') {
                target.blocks.resetCache();
            }

            if (incomingVersion > 0) {
                spriteVersions.set(syncKey, incomingVersion);
            }
            return true;
        } catch (err) {
            console.error("[Collab ❌] Lỗi khi áp dụng blocks! Đang tự động khôi phục dữ liệu an toàn...", err);
            // ROLLBACK NGAY LẬP TỨC NẾU CÓ LỖI XẢY RA
            const backup = localBackups.get(syncKey);
            if (backup) {
                target.blocks._blocks = backup.blocks;
                target.blocks._comments = backup.comments;
                if (typeof target.blocks.resetCache === 'function') target.blocks.resetCache();
                Scratch.vm.emitWorkspaceUpdate();
            }
            return false;
        }
    }

    // --- 🎨 2. HỖ TRỢ ĐÓNG GÓI VÀ GIẢI MÃ ASSET TRANG PHỤC (COSTUME DATA URI) ---
    function serializeCostume(costume) {
        if (!costume) return null;
        let dataURI = null;
        try {
            let asset = costume.asset;
            if (!asset && costume.assetId && Scratch.vm.runtime.storage) {
                asset = Scratch.vm.runtime.storage.get(costume.assetId);
            }
            if (asset && typeof asset.encodeDataURI === 'function') {
                dataURI = asset.encodeDataURI();
            } else if (asset && asset.data) {
                // Dự phòng tự chuyển Uint8Array sang Base64 nếu encodeDataURI không có sẵn
                const mime = costume.dataFormat === 'svg' ? 'image/svg+xml' : (costume.dataFormat === 'png' ? 'image/png' : 'image/jpeg');
                let binary = '';
                const bytes = new Uint8Array(asset.data);
                for (let i = 0; i < bytes.byteLength; i++) {
                    binary += String.fromCharCode(bytes[i]);
                }
                dataURI = `data:${mime};base64,` + btoa(binary);
            }
        } catch (err) {
            console.error("[Collab] Lỗi encode costume asset:", err);
        }
        return {
            name: costume.name,
            dataFormat: costume.dataFormat,
            assetId: costume.assetId,
            md5ext: costume.md5ext || (costume.assetId ? `${costume.assetId}.${costume.dataFormat}` : null),
            rotationCenterX: costume.rotationCenterX,
            rotationCenterY: costume.rotationCenterY,
            bitmapResolution: costume.bitmapResolution || 1,
            dataURI: dataURI
        };
    }

    async function deserializeCostume(costumeData) {
        if (!costumeData) return null;
        const storage = Scratch.vm.runtime.storage;
        let asset = null;

        if (storage) {
            asset = storage.get(costumeData.assetId);
            if (!asset && costumeData.dataURI) {
                try {
                    const res = await fetch(costumeData.dataURI);
                    const blob = await res.blob();
                    const buffer = new Uint8Array(await blob.arrayBuffer());
                    const isSvg = costumeData.dataFormat === 'svg';
                    const assetType = isSvg
                        ? (storage.AssetType ? storage.AssetType.ImageVector : 'ImageVector')
                        : (storage.AssetType ? storage.AssetType.ImageBitmap : 'ImageBitmap');

                    asset = storage.createAsset(
                        assetType,
                        costumeData.dataFormat,
                        buffer,
                        costumeData.assetId,
                        false
                    );
                } catch (e) {
                    console.error("[Collab] Lỗi tạo asset từ dataURI:", e);
                }
            }
        }

        return {
            name: costumeData.name,
            dataFormat: costumeData.dataFormat,
            asset: asset,
            assetId: costumeData.assetId,
            md5: costumeData.md5ext || `${costumeData.assetId}.${costumeData.dataFormat}`,
            rotationCenterX: costumeData.rotationCenterX,
            rotationCenterY: costumeData.rotationCenterY,
            bitmapResolution: costumeData.bitmapResolution || 1
        };
    }

    // --- 🎭 HOOK VÀO THUỘC TÍNH NHÂN VẬT & QUẢN LÝ TRANG PHỤC ---
    function setupSpriteHooks() {
        const stage = Scratch.vm.runtime.targets[0];
        const targetProto = Object.getPrototypeOf(stage);

        // 1. Đồng bộ Kéo thả Tọa độ
        const originalSetXY = targetProto.setXY;
        targetProto.setXY = function(x, y, force) {
            originalSetXY.call(this, x, y, force);
            if (!isApplyingRemote && room && this.isOriginal) {
                const now = Date.now();
                if (now - (this._lastXYSync || 0) > 40) {
                    this._lastXYSync = now;
                    room.broadcastEvent({
                        type: 'SYNC_SPRITE_PROP', spriteKey: getSyncKey(this),
                        prop: 'xy', value: { x: this.x, y: this.y }
                    });
                }
            }
        };

        // 2. Đồng bộ Kích thước
        const originalSetSize = targetProto.setSize;
        targetProto.setSize = function(size) {
            originalSetSize.call(this, size);
            if (!isApplyingRemote && room && this.isOriginal) {
                room.broadcastEvent({
                    type: 'SYNC_SPRITE_PROP', spriteKey: getSyncKey(this),
                    prop: 'size', value: this.size
                });
            }
        };

        // 3. Đồng bộ Hướng (Xoay)
        const originalSetDirection = targetProto.setDirection;
        targetProto.setDirection = function(dir) {
            originalSetDirection.call(this, dir);
            if (!isApplyingRemote && room && this.isOriginal) {
                room.broadcastEvent({
                    type: 'SYNC_SPRITE_PROP', spriteKey: getSyncKey(this),
                    prop: 'direction', value: this.direction
                });
            }
        };

        // 4. Đồng bộ Chuyển đổi Trang Phục đang mặc
        const originalSetCostume = targetProto.setCostume;
        targetProto.setCostume = function(index) {
            originalSetCostume.call(this, index);
            if (!isApplyingRemote && room && this.isOriginal) {
                room.broadcastEvent({
                    type: 'SYNC_SPRITE_PROP', spriteKey: getSyncKey(this),
                    prop: 'costume', value: this.currentCostume
                });
            }
        };

        // 5. Đồng bộ THÊM Trang Phục mới
        const originalAddCostume = targetProto.addCostume;
        targetProto.addCostume = function(costume, optIndex) {
            const syncKey = getSyncKey(this);
            if (!isApplyingRemote) {
                const editor = getOtherCostumeEditor(syncKey, optIndex);
                if (editor) {
                    alert(`[Khóa chỉnh sửa] ${editor.userName} đang thao tác với trang phục này!`);
                    return null;
                }
                acquireCostumeLock(syncKey, optIndex);
            }
            const isLocal = !isApplyingRemote;
            const result = originalAddCostume.call(this, costume, optIndex);
            if (isLocal && room && this.isOriginal) {
                try {
                    const costumeData = serializeCostume(costume);
                    sendChunkedPayload('SYNC_ADD_COSTUME', syncKey, {
                        costume: costumeData,
                        optIndex: optIndex
                    });
                } catch (err) {
                    console.error("[Collab] Lỗi gửi costume chunked:", err);
                }
            }
            return result;
        };

        // 6. Đồng bộ XÓA Trang Phục
        if (targetProto.deleteCostume) {
            const originalDeleteCostume = targetProto.deleteCostume;
            targetProto.deleteCostume = function(index) {
                const syncKey = getSyncKey(this);
                if (!isApplyingRemote) {
                    const editor = getOtherCostumeEditor(syncKey, index);
                    if (editor) {
                        alert(`[Khóa chỉnh sửa] Không thể xóa! ${editor.userName} đang vẽ trang phục này.`);
                        return;
                    }
                }
                const isLocal = !isApplyingRemote;
                const result = originalDeleteCostume.call(this, index);
                if (isLocal && room && this.isOriginal) {
                    room.broadcastEvent({
                        type: 'SYNC_DELETE_COSTUME',
                        spriteKey: syncKey,
                        index: index
                    });
                }
                return result;
            };
        }

        // 7. Đồng bộ ĐỔI TÊN Trang Phục
        if (targetProto.renameCostume) {
            const originalRenameCostume = targetProto.renameCostume;
            targetProto.renameCostume = function(costumeIndex, newName) {
                const syncKey = getSyncKey(this);
                if (!isApplyingRemote) {
                    const editor = getOtherCostumeEditor(syncKey, costumeIndex);
                    if (editor) {
                        alert(`[Khóa chỉnh sửa] Không thể đổi tên! ${editor.userName} đang mở trang phục này.`);
                        return;
                    }
                }
                const isLocal = !isApplyingRemote;
                const result = originalRenameCostume.call(this, costumeIndex, newName);
                if (isLocal && room && this.isOriginal) {
                    room.broadcastEvent({
                        type: 'SYNC_RENAME_COSTUME',
                        spriteKey: syncKey,
                        costumeIndex: costumeIndex,
                        newName: newName
                    });
                }
                return result;
            };
        }

        // 8. Đồng bộ Vẽ Vector SVG (Chỉ cho phép vẽ nếu không có ai khác đang giữ khóa)
        if (targetProto.updateSvg) {
            const originalUpdateSvg = targetProto.updateSvg;
            targetProto.updateSvg = function(costumeIndex, svg, rotationCenterX, rotationCenterY) {
                const syncKey = getSyncKey(this);
                if (!isApplyingRemote) {
                    const editor = getOtherCostumeEditor(syncKey, costumeIndex);
                    if (editor) {
                        showCostumeLock(`🔒 ${editor.userName} đang vẽ trang phục này. Bạn chỉ đang xem trực tiếp!`);
                        return; // Chặn máy này không cho ghi đè
                    }
                    acquireCostumeLock(syncKey, costumeIndex);
                }

                const isLocal = !isApplyingRemote;
                const result = originalUpdateSvg.call(this, costumeIndex, svg, rotationCenterX, rotationCenterY);
                if (isLocal && room && this.isOriginal) {
                    sendChunkedPayload('SYNC_UPDATE_SVG', syncKey, {
                        costumeIndex, svg, rotationCenterX, rotationCenterY
                    });
                }
                return result;
            };
        }

        // 9. Đồng bộ Vẽ Bitmap Pixel (Chỉ cho phép vẽ nếu không có ai khác đang giữ khóa)
        if (targetProto.updateBitmap) {
            const originalUpdateBitmap = targetProto.updateBitmap;
            targetProto.updateBitmap = function(costumeIndex, bitmap, rotationCenterX, rotationCenterY) {
                const syncKey = getSyncKey(this);
                if (!isApplyingRemote) {
                    const editor = getOtherCostumeEditor(syncKey, costumeIndex);
                    if (editor) {
                        showCostumeLock(`🔒 ${editor.userName} đang vẽ trang phục này. Bạn chỉ đang xem trực tiếp!`);
                        return; // Chặn máy này không cho ghi đè
                    }
                    acquireCostumeLock(syncKey, costumeIndex);
                }

                const isLocal = !isApplyingRemote;
                const result = originalUpdateBitmap.call(this, costumeIndex, bitmap, rotationCenterX, rotationCenterY);
                if (isLocal && room && this.isOriginal) {
                    let dataURI = null;
                    if (bitmap instanceof HTMLCanvasElement) {
                        dataURI = bitmap.toDataURL('image/png');
                    } else if (bitmap && bitmap.data) {
                        const canvas = document.createElement('canvas');
                        canvas.width = bitmap.width;
                        canvas.height = bitmap.height;
                        const ctx = canvas.getContext('2d');
                        ctx.putImageData(bitmap, 0, 0);
                        dataURI = canvas.toDataURL('image/png');
                    }
                    if (dataURI) {
                        sendChunkedPayload('SYNC_UPDATE_BITMAP', syncKey, {
                            costumeIndex, dataURI, rotationCenterX, rotationCenterY
                        });
                    }
                }
                return result;
            };
        }

        // 10. Đổi tên nhân vật
        const originalRenameSprite = Scratch.vm.renameSprite;
        Scratch.vm.renameSprite = function(targetId, newName) {
            const target = Scratch.vm.runtime.getTargetById(targetId);
            const oldName = target ? getSyncKey(target) : null;
            
            originalRenameSprite.call(this, targetId, newName);
            
            if (!isApplyingRemote && room && oldName && sharedBlocks) {
                const blocks = sharedBlocks.get(oldName);
                if (blocks) {
                    sharedBlocks.set(newName, blocks);
                    sharedBlocks.delete(oldName);
                }
                room.broadcastEvent({ type: 'SYNC_SPRITE_RENAME', oldKey: oldName, newKey: newName });
            }
        };
    }

    // --- HACK VÀO KHỐI LỆNH, CHÚ THÍCH (NOTES) VÀ SPRITE ---
    function setupVMHooks() {
        const stage = Scratch.vm.runtime.targets[0];
        const blockContainerProto = Object.getPrototypeOf(stage.blocks);
        const originalBlocklyListen = blockContainerProto.blocklyListen;

        blockContainerProto.blocklyListen = function(e) {
            originalBlocklyListen.call(this, e);
            if (isApplyingRemote || !room) return;
            if (e.isRemote || e.type === 'ui') return;

            // [ĐÃ SỬA] Bổ sung các sự kiện liên quan đến Workspace Comments/Notes
            const SYNC_EVENTS = [
                'create', 'delete', 'move', 'change',
                'comment_create', 'comment_change', 'comment_move', 'comment_delete'
            ];

            if (SYNC_EVENTS.includes(e.type)) {
                let target = null;
                for (const t of Scratch.vm.runtime.targets) {
                    if (t.blocks === this) { target = t; break; }
                }
                if (target) {
                    const syncKey = getSyncKey(target);
                    const newVersion = (spriteVersions.get(syncKey) || 0) + 1;
                    spriteVersions.set(syncKey, newVersion);

                    // Đóng gói cả khối lệnh, chú thích và gắn nhãn Version & Timestamp chống xung đột
                    const payload = {
                        blocks: this._blocks,
                        comments: this._comments,
                        version: newVersion,
                        timestamp: Date.now()
                    };
                    const payloadString = JSON.stringify(payload);
                    if (sharedBlocks) sharedBlocks.set(syncKey, payloadString);
                    room.broadcastEvent({ 
                        type: 'INSTANT_BLOCK_SYNC', 
                        spriteKey: syncKey, 
                        data: payloadString,
                        version: newVersion
                    });
                }
            }
        };

        // 1. Tự động kéo code và note về khi chuyển Sprite
        const originalSetEditingTarget = Scratch.vm.setEditingTarget;
        Scratch.vm.setEditingTarget = function(targetId) {
            originalSetEditingTarget.call(this, targetId);
            if (sharedBlocks) {
                const target = Scratch.vm.editingTarget;
                if (target) {
                    const cloudStr = sharedBlocks.get(getSyncKey(target));
                    if (cloudStr) {
                        isApplyingRemote = true;
                        applyBlocksToTarget(target, JSON.parse(cloudStr));
                        Scratch.vm.emitWorkspaceUpdate();
                        setTimeout(() => { isApplyingRemote = false; }, 50);
                    }
                }
            }
        };

        // 2. Tạo Sprite mới (Đã tối ưu Chunking & chống treo âm thanh)
        const originalAddSprite = Scratch.vm.addSprite;
        Scratch.vm.addSprite = async function(input) {
            const isLocal = !isApplyingRemote;
            const result = await originalAddSprite.call(this, input);
            if (isLocal && room) {
                // Lấy chính xác sprite vừa tạo (hỗ trợ cả trường hợp trả về object hoặc target cuối)
                const newTarget = (result && result.id ? result : (Array.isArray(result) ? result[0] : null)) 
                    || Scratch.vm.runtime.targets[Scratch.vm.runtime.targets.length - 1];

                if (newTarget && !newTarget.isStage) {
                    try {
                        const targetJSON = newTarget.toJSON();
                        targetJSON.blocks = {}; // Blocks đồng bộ qua kênh riêng
                        targetJSON.sounds = []; // Loại bỏ tạm sound để Scratch không bị treo khi tải từ CDN
                        const serializedCostumes = (newTarget.sprite.costumes || []).map(serializeCostume);

                        // Truyền dần dần qua sendChunkedPayload để không bao giờ bị nghẽn mạng Liveblocks
                        sendChunkedPayload('SYNC_NEW_SPRITE', getSyncKey(newTarget), {
                            spriteJSON: targetJSON,
                            costumes: serializedCostumes
                        });
                    } catch (err) {
                        console.error("[Collab] Lỗi gửi tạo sprite chunked:", err);
                    }
                }
            }
            return result;
        };

        // 3. Nhân bản Sprite (Đã tối ưu Chunking)
        const originalDuplicateSprite = Scratch.vm.duplicateSprite;
        Scratch.vm.duplicateSprite = async function(targetId) {
            const isLocal = !isApplyingRemote;
            const result = await originalDuplicateSprite.call(this, targetId);
            if (isLocal && room) {
                const newTarget = (result && result.id ? result : (Array.isArray(result) ? result[0] : null)) 
                    || Scratch.vm.runtime.targets[Scratch.vm.runtime.targets.length - 1];

                if (newTarget && !newTarget.isStage) {
                    try {
                        const targetJSON = newTarget.toJSON();
                        targetJSON.blocks = {};
                        targetJSON.sounds = [];
                        const serializedCostumes = (newTarget.sprite.costumes || []).map(serializeCostume);

                        sendChunkedPayload('SYNC_NEW_SPRITE', getSyncKey(newTarget), {
                            spriteJSON: targetJSON,
                            costumes: serializedCostumes
                        });
                    } catch (err) {
                        console.error("[Collab] Lỗi gửi nhân bản sprite chunked:", err);
                    }
                }
            }
            return result;
        };

        // 4. Xóa Sprite
        const originalDeleteSprite = Scratch.vm.deleteSprite;
        Scratch.vm.deleteSprite = function(targetId) {
            const target = Scratch.vm.runtime.getTargetById(targetId);
            const syncKey = target ? getSyncKey(target) : null;
            const isLocal = !isApplyingRemote;
            
            const result = originalDeleteSprite.call(this, targetId);
            if (isLocal && room && syncKey) {
                room.broadcastEvent({ type: 'SYNC_DELETE_SPRITE', spriteKey: syncKey });
                if (sharedBlocks) sharedBlocks.delete(syncKey);
            }
            return result;
        };

        // 5. Tải Custom Extension
        const em = Scratch.vm.extensionManager;
        if (em && em.loadExtensionURL) {
            const originalLoadExt = em.loadExtensionURL;
            em.loadExtensionURL = async function(url) {
                const isLocal = !isApplyingRemote;
                const result = await originalLoadExt.call(this, url);
                if (isLocal && room) {
                    room.broadcastEvent({ type: 'SYNC_EXTENSION', url: url });
                }
                return result;
            };
        }
    }

    class LiveblocksCollab {
        getInfo() {
            return {
                id: 'liveblockscollab',
                name: 'Live Collab Pro',
                color1: '#0055ff', color2: '#0044cc',
                blocks: [
                    {
                        opcode: 'connectRoom',
                        blockType: Scratch.BlockType.COMMAND,
                        text: 'Vào phòng chung [ROOM_ID]',
                        arguments: { ROOM_ID: { type: Scratch.ArgumentType.STRING, defaultValue: 'phong-test-1' } }
                    }
                ]
            };
        }

        connectRoom(args) {
            const roomId = args.ROOM_ID;
            if (room) return;

            console.log(`[Collab 🚀] Kết nối phòng: ${roomId}...`);
            setupDOM();
            setupVMHooks();
            setupSpriteHooks();
            setupCostumeInteractionListeners();

            try {
                const response = client.enterRoom(roomId, {
                    initialPresence: { cursor: null, editingCostume: null },
                    initialStorage: { sharedBlocks: new LiveMap() }
                });
                
                room = response.room;

                document.addEventListener('mousemove', (e) => {
                    if (Date.now() - lastMouseTime > 50) {
                        room.updatePresence({ cursor: { x: e.clientX, y: e.clientY } });
                        lastMouseTime = Date.now();
                    }
                });

                room.subscribe("others", () => {
                    const others = room.getOthers();
                    const activeIds = new Set();
                    let someoneEditingCurrentCostume = false;
                    let currentEditorName = "Người dùng khác";

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
                                el = document.createElement('div');
                                el.style.cssText = `position:absolute; width:15px; height:15px; background:#ff0044; border:2px solid #fff; border-radius:50%; transform:translate(-50%,-50%); transition: left 0.1s linear, top 0.1s linear; box-shadow: 0 2px 4px rgba(0,0,0,0.5); pointer-events: none; z-index: 999999;`;
                                cursorsContainer.appendChild(el);
                                cursorElements.set(cid, el);
                            }
                            el.style.left = p.cursor.x + 'px'; el.style.top = p.cursor.y + 'px';
                        }

                        // KIỂM TRA XEM CÓ AI ĐANG SỬA TRANG PHỤC NÀY KHÔNG (Có hạn trong vòng 10 giây)
                        if (p && p.editingCostume && (now - p.editingCostume.timestamp < 10000)) {
                            if (currentSyncKey && p.editingCostume.spriteKey === currentSyncKey) {
                                if (p.editingCostume.costumeIndex === undefined || p.editingCostume.costumeIndex === currentCostumeIdx) {
                                    someoneEditingCurrentCostume = true;
                                    currentEditorName = p.name || `Người dùng #${user.connectionId}`;
                                }
                            }
                        }
                    });

                    // CẬP NHẬT MÀN CHẮN KHÓA DOM TRÊN GIAO DIỆN CỦA B
                    updateDOMCostumeCurtain(someoneEditingCurrentCostume, currentEditorName);

                    if (someoneEditingCurrentCostume) {
                        showCostumeLock(`👁️ Đang xem trực tiếp: ${currentEditorName} đang vẽ trang phục này!`);
                    } else if (!isCostumeLocked) {
                        hideCostumeLock();
                    }

                    for (const [id, el] of cursorElements) {
                        if (!activeIds.has(id)) { el.remove(); cursorElements.delete(id); }
                    }
                });

                room.subscribe("event", ({ event }) => {
                    // 1. NHẬN KHỐI LỆNH & CHÚ THÍCH (NOTES) CÓ BẢO VỆ CHỐNG GHI ĐÈ
                    if (event.type === 'INSTANT_BLOCK_SYNC') {
                        const target = getTargetBySyncKey(event.spriteKey);
                        if (target) {
                            isApplyingRemote = true;
                            try {
                                const parsed = JSON.parse(event.data || event.blockData);
                                const ok = applyBlocksToTarget(target, parsed, event.version || parsed.version || 0);
                                if (ok) {
                                    const currentTargetNow = Scratch.vm.editingTarget;
                                    if (currentTargetNow && getSyncKey(currentTargetNow) === event.spriteKey) {
                                        Scratch.vm.emitWorkspaceUpdate();
                                    }
                                }
                            } catch (e) {
                                console.error("[Collab] Lỗi parse dữ liệu blocks từ mạng:", e);
                            } finally {
                                setTimeout(() => { isApplyingRemote = false; }, 100);
                            }
                        }
                    }

                    // 2. NHẬN ĐỔI TÊN NHÂN VẬT
                    if (event.type === 'SYNC_SPRITE_RENAME') {
                        const target = getTargetBySyncKey(event.oldKey);
                        if (target) {
                            isApplyingRemote = true;
                            Scratch.vm.renameSprite(target.id, event.newKey);
                            setTimeout(() => { isApplyingRemote = false; }, 50);
                        }
                    }

                    // 3. NHẬN THUỘC TÍNH / SỐ THỨ TỰ TRANG PHỤC ĐANG MẶC
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

                    // --- BẮT ĐẦU NHẬN CHUNK: KHÓA CHỈNH SỬA & HIỆN THÔNG BÁO ---
                    if (event.type === 'TRANSFER_START') {
                        isCostumeLocked = true;
                        showCostumeLock(`Đang tải trang phục của [${event.spriteKey}]... Vui lòng không sửa!`);
                        
                        // Hủy bỏ phiên truyền cũ nếu quá 15 giây mà không hoàn tất (chống kẹt khóa)
                        const existing = incomingTransfers.get(event.transferId);
                        if (existing && existing.timeoutId) clearTimeout(existing.timeoutId);

                        const timeoutId = setTimeout(() => {
                            incomingTransfers.delete(event.transferId);
                            isCostumeLocked = false;
                            hideCostumeLock();
                            console.warn("[Collab ⚠️] Nhận dữ liệu trang phục quá thời gian, đã tự động mở khóa.");
                        }, 15000);

                        incomingTransfers.set(event.transferId, {
                            action: event.action,
                            spriteKey: event.spriteKey,
                            receivedCount: 0,
                            chunks: [],
                            timeoutId: timeoutId
                        });
                    }

                    // --- NHẬN TỪNG MẢNH VÀ GHÉP DỮ LIỆU ---
                    if (event.type === 'TRANSFER_CHUNK') {
                        const session = incomingTransfers.get(event.transferId);
                        if (session) {
                            session.chunks[event.index] = event.chunk;
                            session.receivedCount++;

                            // Cập nhật tiến độ tải lên giao diện (Lazyload progress)
                            const percent = Math.round((session.receivedCount / event.total) * 100);
                            showCostumeLock(`Đang tải trang phục [${session.spriteKey}]: ${percent}%...`);

                            // Khi đã nhận đủ 100% tất cả các mảnh
                            if (session.receivedCount === event.total) {
                                clearTimeout(session.timeoutId);
                                const fullJsonString = session.chunks.join('');
                                incomingTransfers.delete(event.transferId);

                                try {
                                    const data = JSON.parse(fullJsonString);
                                    const target = getTargetBySyncKey(session.spriteKey);
                                    if (target) {
                                        isApplyingRemote = true;

                                        // 1. Nhận thêm trang phục
                                        if (session.action === 'SYNC_ADD_COSTUME') {
                                            deserializeCostume(data.costume).then(costumeObj => {
                                                if (costumeObj) {
                                                    target.addCostume(costumeObj, data.optIndex);
                                                    Scratch.vm.emitTargetsUpdate();
                                                }
                                            }).finally(() => {
                                                setTimeout(() => { isApplyingRemote = false; }, 50);
                                            });
                                        }

                                        // 2. Nhận vẽ Vector SVG
                                        if (session.action === 'SYNC_UPDATE_SVG') {
                                            if (typeof target.updateSvg === 'function') {
                                                target.updateSvg(data.costumeIndex, data.svg, data.rotationCenterX, data.rotationCenterY);
                                                Scratch.vm.emitTargetsUpdate();
                                            }
                                            setTimeout(() => { isApplyingRemote = false; }, 50);
                                        }

                                        // 3. Nhận vẽ Bitmap Pixel
                                        if (session.action === 'SYNC_UPDATE_BITMAP') {
                                            const img = new Image();
                                            img.onload = () => {
                                                const canvas = document.createElement('canvas');
                                                canvas.width = img.width;
                                                canvas.height = img.height;
                                                const ctx = canvas.getContext('2d');
                                                ctx.drawImage(img, 0, 0);
                                                if (typeof target.updateBitmap === 'function') {
                                                    target.updateBitmap(data.costumeIndex, canvas, data.rotationCenterX, data.rotationCenterY);
                                                    Scratch.vm.emitTargetsUpdate();
                                                }
                                                setTimeout(() => { isApplyingRemote = false; }, 50);
                                            };
                                            img.src = data.dataURI;
                                        }

                                        // 3.5. Nhận bản xem trực tiếp mỗi 5s khi người khác đang vẽ (LIVE SPECTATE)
                                        if (session.action === 'SYNC_LIVE_COSTUME_PREVIEW') {
                                            (async () => {
                                                try {
                                                    const costumeObj = await deserializeCostume(data.costumeData);
                                                    if (costumeObj && target.sprite && target.sprite.costumes[data.costumeIndex]) {
                                                        target.sprite.costumes[data.costumeIndex] = costumeObj;
                                                        // Nạp lại hiển thị cho bàn vẽ và sân khấu của máy xem
                                                        if (target.currentCostume === data.costumeIndex) {
                                                            target.setCostume(data.costumeIndex);
                                                        }
                                                        Scratch.vm.emitTargetsUpdate();
                                                    }
                                                } catch (err) {
                                                    console.error("[Collab] Lỗi áp dụng live preview 5s:", err);
                                                } finally {
                                                    setTimeout(() => { isApplyingRemote = false; }, 50);
                                                }
                                            })();
                                        }
                                    }

                                    // 4. NHẬN TẠO SPRITE MỚI QUA CHUNKING (Cực kỳ an toàn & mượt mà)
                                    if (session.action === 'SYNC_NEW_SPRITE') {
                                        isApplyingRemote = true;
                                        (async () => {
                                            try {
                                                // Nạp trước toàn bộ file ảnh trang phục vào storage của Scratch
                                                if (data.costumes && Array.isArray(data.costumes)) {
                                                    for (const c of data.costumes) {
                                                        await deserializeCostume(c);
                                                    }
                                                }

                                                // Nếu máy này vô tình có sprite trùng tên cũ kẹt lại, xóa đi để lấy tên chuẩn
                                                const duplicateOld = getTargetBySyncKey(session.spriteKey);
                                                if (duplicateOld && !duplicateOld.isStage) {
                                                    Scratch.vm.deleteSprite(duplicateOld.id);
                                                }

                                                // Tạo sprite
                                                const added = await Scratch.vm.addSprite(data.spriteJSON);
                                                const addedTarget = (added && added.id ? added : (Array.isArray(added) ? added[0] : null)) 
                                                    || Scratch.vm.runtime.targets[Scratch.vm.runtime.targets.length - 1];

                                                // Ép tên Sprite của máy nhận phải trùng 100% với máy gửi
                                                if (addedTarget && addedTarget.sprite && addedTarget.sprite.name !== session.spriteKey) {
                                                    addedTarget.sprite.name = session.spriteKey;
                                                }

                                                Scratch.vm.emitTargetsUpdate();
                                                Scratch.vm.emitWorkspaceUpdate();
                                            } catch (err) {
                                                console.error("[Collab ❌] Lỗi tạo sprite từ chunk:", err);
                                            } finally {
                                                setTimeout(() => { isApplyingRemote = false; }, 60);
                                            }
                                        })();
                                    }

                                } catch (err) {
                                    console.error("[Collab ❌] Lỗi ghép mảnh dữ liệu:", err);
                                } finally {
                                    // Mở khóa cho phép người dùng tiếp tục thao tác
                                    isCostumeLocked = false;
                                    hideCostumeLock();
                                }
                            }
                        }
                    }

                    // NHẬN XÓA TRANG PHỤC
                    if (event.type === 'SYNC_DELETE_COSTUME') {
                        const target = getTargetBySyncKey(event.spriteKey);
                        if (target && target.sprite && target.sprite.costumes[event.index]) {
                            isApplyingRemote = true;
                            try {
                                target.deleteCostume(event.index);
                                Scratch.vm.emitTargetsUpdate();
                            } finally {
                                setTimeout(() => { isApplyingRemote = false; }, 50);
                            }
                        }
                    }

                    // NHẬN ĐỔI TÊN TRANG PHỤC
                    if (event.type === 'SYNC_RENAME_COSTUME') {
                        const target = getTargetBySyncKey(event.spriteKey);
                        if (target && target.sprite && target.sprite.costumes[event.costumeIndex]) {
                            isApplyingRemote = true;
                            try {
                                target.renameCostume(event.costumeIndex, event.newName);
                                Scratch.vm.emitTargetsUpdate();
                            } finally {
                                setTimeout(() => { isApplyingRemote = false; }, 50);
                            }
                        }
                    }

                    // 10. NHẬN XÓA SPRITE
                    if (event.type === 'SYNC_DELETE_SPRITE') {
                        const target = getTargetBySyncKey(event.spriteKey);
                        if (target) {
                            isApplyingRemote = true;
                            Scratch.vm.deleteSprite(target.id);
                            setTimeout(() => { isApplyingRemote = false; }, 50);
                        }
                    }

                    // 11. NHẬN TẢI EXTENSION
                    if (event.type === 'SYNC_EXTENSION' && Scratch.vm.extensionManager && Scratch.vm.extensionManager.loadExtensionURL) {
                        isApplyingRemote = true;
                        Scratch.vm.extensionManager.loadExtensionURL(event.url).then(() => {
                            isApplyingRemote = false;
                            Scratch.vm.emitWorkspaceUpdate();
                        }).catch(() => {
                            isApplyingRemote = false;
                        });
                    }
                });

                room.getStorage().then((storage) => {
                    sharedBlocks = storage.root.get("sharedBlocks");
                    
                    for (const target of Scratch.vm.runtime.targets) {
                        const cloudStr = sharedBlocks.get(getSyncKey(target));
                        if (cloudStr) {
                            applyBlocksToTarget(target, JSON.parse(cloudStr));
                        }
                    }
                    Scratch.vm.emitWorkspaceUpdate(); 
                    
                    if (Scratch.vm.extensionManager && Scratch.vm.extensionManager.getExtensionURLs) {
                        const urls = Object.values(Scratch.vm.extensionManager.getExtensionURLs());
                        urls.forEach(url => {
                            room.broadcastEvent({ type: 'SYNC_EXTENSION', url: url });
                        });
                    }

                    console.log("[Collab ✅] ĐÃ SỬA XONG: ĐỒNG BỘ CẢ KHỐI LỆNH, CHÚ THÍCH (NOTES) VÀ TRANG PHỤC (COSTUMES)!");
                });
                
            } catch (err) {
                console.error("[Collab ❌] LỖI:", err);
            }
        }
    }

    Scratch.extensions.register(new LiveblocksCollab());
})(Scratch);