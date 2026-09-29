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

    // --- 🛠️ 1. HỖ TRỢ ĐỒNG BỘ CẢ KHỐI LỆNH & CHÚ THÍCH (NOTES) ---
    function applyBlocksToTarget(target, data) {
        if (!data || !target || !target.blocks) return;
        
        // Hỗ trợ cả định dạng cũ (chỉ có _blocks) và định dạng mới ({ blocks, comments })
        const blocksJSON = (data.blocks !== undefined) ? data.blocks : data;
        const commentsJSON = (data.comments !== undefined) ? data.comments : null;

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

        // 5. [MỚI] Đồng bộ THÊM Trang Phục mới (Upload / Vẽ / Thư viện)
        const originalAddCostume = targetProto.addCostume;
        targetProto.addCostume = function(costume, optIndex) {
            const isLocal = !isApplyingRemote;
            const result = originalAddCostume.call(this, costume, optIndex);
            if (isLocal && room && this.isOriginal) {
                try {
                    const costumeData = serializeCostume(costume);
                    room.broadcastEvent({
                        type: 'SYNC_ADD_COSTUME',
                        spriteKey: getSyncKey(this),
                        costume: costumeData,
                        optIndex: optIndex
                    });
                } catch (err) {
                    console.error("[Collab] Lỗi broadcast thêm costume:", err);
                }
            }
            return result;
        };

        // 6. [MỚI] Đồng bộ XÓA Trang Phục
        if (targetProto.deleteCostume) {
            const originalDeleteCostume = targetProto.deleteCostume;
            targetProto.deleteCostume = function(index) {
                const isLocal = !isApplyingRemote;
                const result = originalDeleteCostume.call(this, index);
                if (isLocal && room && this.isOriginal) {
                    room.broadcastEvent({
                        type: 'SYNC_DELETE_COSTUME',
                        spriteKey: getSyncKey(this),
                        index: index
                    });
                }
                return result;
            };
        }

        // 7. [MỚI] Đồng bộ ĐỔI TÊN Trang Phục
        if (targetProto.renameCostume) {
            const originalRenameCostume = targetProto.renameCostume;
            targetProto.renameCostume = function(costumeIndex, newName) {
                const isLocal = !isApplyingRemote;
                const result = originalRenameCostume.call(this, costumeIndex, newName);
                if (isLocal && room && this.isOriginal) {
                    room.broadcastEvent({
                        type: 'SYNC_RENAME_COSTUME',
                        spriteKey: getSyncKey(this),
                        costumeIndex: costumeIndex,
                        newName: newName
                    });
                }
                return result;
            };
        }

        // 8. [MỚI] Đồng bộ Chỉnh sửa nét vẽ Vector (Paint Editor SVG)
        if (targetProto.updateSvg) {
            const originalUpdateSvg = targetProto.updateSvg;
            targetProto.updateSvg = function(costumeIndex, svg, rotationCenterX, rotationCenterY) {
                const isLocal = !isApplyingRemote;
                const result = originalUpdateSvg.call(this, costumeIndex, svg, rotationCenterX, rotationCenterY);
                if (isLocal && room && this.isOriginal) {
                    room.broadcastEvent({
                        type: 'SYNC_UPDATE_SVG',
                        spriteKey: getSyncKey(this),
                        costumeIndex,
                        svg,
                        rotationCenterX,
                        rotationCenterY
                    });
                }
                return result;
            };
        }

        // 9. [MỚI] Đồng bộ Chỉnh sửa nét vẽ Bitmap (Paint Editor Bitmap)
        if (targetProto.updateBitmap) {
            const originalUpdateBitmap = targetProto.updateBitmap;
            targetProto.updateBitmap = function(costumeIndex, bitmap, rotationCenterX, rotationCenterY) {
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
                        room.broadcastEvent({
                            type: 'SYNC_UPDATE_BITMAP',
                            spriteKey: getSyncKey(this),
                            costumeIndex,
                            dataURI,
                            rotationCenterX,
                            rotationCenterY
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
                    // [ĐÃ SỬA] Đóng gói cả khối lệnh (_blocks) và chú thích (_comments)
                    const payload = {
                        blocks: this._blocks,
                        comments: this._comments
                    };
                    const payloadString = JSON.stringify(payload);
                    if (sharedBlocks) sharedBlocks.set(syncKey, payloadString);
                    room.broadcastEvent({ type: 'INSTANT_BLOCK_SYNC', spriteKey: syncKey, data: payloadString });
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

        // 2. Tạo Sprite mới (Kèm nạp sẵn costume assets)
        const originalAddSprite = Scratch.vm.addSprite;
        Scratch.vm.addSprite = async function(input) {
            const isLocal = !isApplyingRemote;
            const result = await originalAddSprite.call(this, input);
            if (isLocal && room) {
                const newTarget = Scratch.vm.runtime.targets[Scratch.vm.runtime.targets.length - 1];
                if (newTarget && !newTarget.isStage) {
                    try {
                        const targetJSON = newTarget.toJSON();
                        targetJSON.blocks = {};
                        const serializedCostumes = (newTarget.sprite.costumes || []).map(serializeCostume);
                        room.broadcastEvent({ 
                            type: 'SYNC_NEW_SPRITE', 
                            spriteKey: getSyncKey(newTarget), 
                            spriteJSON: JSON.stringify(targetJSON),
                            costumes: serializedCostumes
                        });
                    } catch (err) {
                        console.error("[Collab] Lỗi đồng bộ tạo sprite:", err);
                    }
                }
            }
            return result;
        };

        // 3. Nhân bản Sprite
        const originalDuplicateSprite = Scratch.vm.duplicateSprite;
        Scratch.vm.duplicateSprite = async function(targetId) {
            const isLocal = !isApplyingRemote;
            const result = await originalDuplicateSprite.call(this, targetId);
            if (isLocal && room) {
                const newTarget = Scratch.vm.runtime.targets[Scratch.vm.runtime.targets.length - 1];
                if (newTarget && !newTarget.isStage) {
                    try {
                        const targetJSON = newTarget.toJSON();
                        targetJSON.blocks = {};
                        const serializedCostumes = (newTarget.sprite.costumes || []).map(serializeCostume);
                        room.broadcastEvent({ 
                            type: 'SYNC_NEW_SPRITE', 
                            spriteKey: getSyncKey(newTarget), 
                            spriteJSON: JSON.stringify(targetJSON),
                            costumes: serializedCostumes
                        });
                    } catch (err) {
                        console.error("[Collab] Lỗi đồng bộ nhân bản sprite:", err);
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

            try {
                const response = client.enterRoom(roomId, {
                    initialPresence: { cursor: null },
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
                    });
                    for (const [id, el] of cursorElements) {
                        if (!activeIds.has(id)) { el.remove(); cursorElements.delete(id); }
                    }
                });

                room.subscribe("event", ({ event }) => {
                    // 1. NHẬN KHỐI LỆNH & CHÚ THÍCH (NOTES)
                    if (event.type === 'INSTANT_BLOCK_SYNC') {
                        const target = getTargetBySyncKey(event.spriteKey);
                        if (target) {
                            isApplyingRemote = true;
                            const parsed = JSON.parse(event.data || event.blockData);
                            applyBlocksToTarget(target, parsed);
                            const currentTargetNow = Scratch.vm.editingTarget;
                            if (currentTargetNow && getSyncKey(currentTargetNow) === event.spriteKey) {
                                Scratch.vm.emitWorkspaceUpdate();
                            }
                            setTimeout(() => { isApplyingRemote = false; }, 100);
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

                    // 4. [MỚI] NHẬN THÊM TRANG PHỤC MỚI
                    if (event.type === 'SYNC_ADD_COSTUME') {
                        const target = getTargetBySyncKey(event.spriteKey);
                        if (target) {
                            isApplyingRemote = true;
                            deserializeCostume(event.costume).then(costumeObj => {
                                if (costumeObj) {
                                    target.addCostume(costumeObj, event.optIndex);
                                    Scratch.vm.emitTargetsUpdate();
                                }
                            }).catch(err => {
                                console.error("[Collab] Lỗi thêm costume:", err);
                            }).finally(() => {
                                setTimeout(() => { isApplyingRemote = false; }, 50);
                            });
                        }
                    }

                    // 5. [MỚI] NHẬN XÓA TRANG PHỤC
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

                    // 6. [MỚI] NHẬN ĐỔI TÊN TRANG PHỤC
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

                    // 7. [MỚI] NHẬN CẬP NHẬT VẼ TRANG PHỤC VECTOR (SVG)
                    if (event.type === 'SYNC_UPDATE_SVG') {
                        const target = getTargetBySyncKey(event.spriteKey);
                        if (target && target.sprite && target.sprite.costumes[event.costumeIndex]) {
                            isApplyingRemote = true;
                            try {
                                if (typeof target.updateSvg === 'function') {
                                    target.updateSvg(event.costumeIndex, event.svg, event.rotationCenterX, event.rotationCenterY);
                                    Scratch.vm.emitTargetsUpdate();
                                }
                            } finally {
                                setTimeout(() => { isApplyingRemote = false; }, 50);
                            }
                        }
                    }

                    // 8. [MỚI] NHẬN CẬP NHẬT VẼ TRANG PHỤC BITMAP (PNG)
                    if (event.type === 'SYNC_UPDATE_BITMAP') {
                        const target = getTargetBySyncKey(event.spriteKey);
                        if (target && target.sprite && target.sprite.costumes[event.costumeIndex]) {
                            isApplyingRemote = true;
                            const img = new Image();
                            img.onload = () => {
                                const canvas = document.createElement('canvas');
                                canvas.width = img.width;
                                canvas.height = img.height;
                                const ctx = canvas.getContext('2d');
                                ctx.drawImage(img, 0, 0);
                                try {
                                    if (typeof target.updateBitmap === 'function') {
                                        target.updateBitmap(event.costumeIndex, canvas, event.rotationCenterX, event.rotationCenterY);
                                        Scratch.vm.emitTargetsUpdate();
                                    }
                                } finally {
                                    setTimeout(() => { isApplyingRemote = false; }, 50);
                                }
                            };
                            img.src = event.dataURI;
                        }
                    }

                    // 9. NHẬN TẠO SPRITE MỚI
                    if (event.type === 'SYNC_NEW_SPRITE') {
                        const existing = getTargetBySyncKey(event.spriteKey);
                        if (!existing) {
                            isApplyingRemote = true;
                            (async () => {
                                try {
                                    if (event.costumes && Array.isArray(event.costumes)) {
                                        for (const c of event.costumes) {
                                            await deserializeCostume(c);
                                        }
                                    }
                                    await Scratch.vm.addSprite(event.spriteJSON);
                                    Scratch.vm.emitWorkspaceUpdate();
                                    Scratch.vm.emitTargetsUpdate();
                                } catch (err) {
                                    console.error("[Collab ❌] Lỗi tạo sprite từ mạng:", err);
                                } finally {
                                    setTimeout(() => { isApplyingRemote = false; }, 50);
                                }
                            })();
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