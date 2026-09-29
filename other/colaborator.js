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
    let isApplyingRemote = false; // Chốt an toàn chống dội ngược mạng

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

    function applyBlocksToTarget(target, newBlocksJSON) {
        target.blocks._blocks = newBlocksJSON;
        const scripts = [];
        for (const id in newBlocksJSON) {
            if (newBlocksJSON[id].topLevel) scripts.push(id);
        }
        target.blocks._scripts = scripts;
        if (typeof target.blocks.resetCache === 'function') {
            target.blocks.resetCache();
        }
    }

    // --- 🎭 TÍNH NĂNG MỚI: HACK VÀO THUỘC TÍNH NHÂN VẬT & TRANG PHỤC ---
    function setupSpriteHooks() {
        const stage = Scratch.vm.runtime.targets[0];
        const targetProto = Object.getPrototypeOf(stage);

        // 1. Đồng bộ Kéo thả Tọa độ (Có Throttle để mạng không bị sập khi kéo nhanh)
        const originalSetXY = targetProto.setXY;
        targetProto.setXY = function(x, y, force) {
            originalSetXY.call(this, x, y, force);
            if (!isApplyingRemote && room && this.isOriginal) {
                const now = Date.now();
                if (now - (this._lastXYSync || 0) > 40) { // Gửi tối đa 25 lần/giây
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

        // 4. Đồng bộ chuyển đổi Trang Phục
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

        // 5. BẢO VỆ ĐƯỜNG TRUYỀN KHI ĐỔI TÊN NHÂN VẬT
        const originalRenameSprite = Scratch.vm.renameSprite;
        Scratch.vm.renameSprite = function(targetId, newName) {
            const target = Scratch.vm.runtime.getTargetById(targetId);
            const oldName = target ? getSyncKey(target) : null;
            
            originalRenameSprite.call(this, targetId, newName); // Gọi logic gốc
            
            if (!isApplyingRemote && room && oldName && sharedBlocks) {
                // Sửa tên file trên Cloud để không mất khối lệnh
                const blocks = sharedBlocks.get(oldName);
                if (blocks) {
                    sharedBlocks.set(newName, blocks);
                    sharedBlocks.delete(oldName);
                }
                // Hét lên cho máy bên kia đổi tên theo
                room.broadcastEvent({ type: 'SYNC_SPRITE_RENAME', oldKey: oldName, newKey: newName });
            }
        };
    }

    // --- HACK VÀO KHỐI LỆNH & SỰ KIỆN CHUYỂN SPRITE ---
    function setupVMHooks() {
        const stage = Scratch.vm.runtime.targets[0];
        const blockContainerProto = Object.getPrototypeOf(stage.blocks);
        const originalBlocklyListen = blockContainerProto.blocklyListen;

        blockContainerProto.blocklyListen = function(e) {
            originalBlocklyListen.call(this, e);
            if (isApplyingRemote || !room) return;
            if (e.isRemote || e.type === 'ui') return;

            if (['create', 'delete', 'move', 'change'].includes(e.type)) {
                let target = null;
                for (const t of Scratch.vm.runtime.targets) {
                    if (t.blocks === this) { target = t; break; }
                }

                if (target) {
                    const syncKey = getSyncKey(target);
                    const blocksString = JSON.stringify(this._blocks);
                    
                    if (sharedBlocks) sharedBlocks.set(syncKey, blocksString);
                    room.broadcastEvent({ type: 'INSTANT_BLOCK_SYNC', spriteKey: syncKey, blockData: blocksString });
                }
            }
        };

        // HACK: Tự động kéo code từ mạng về mỗi khi bấm chọn một Sprite bất kỳ
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
            setupSpriteHooks(); // <--- Kích hoạt siêu năng lực mới

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
                    // 1. NHẬN KHỐI LỆNH
                    if (event.type === 'INSTANT_BLOCK_SYNC') {
                        const target = getTargetBySyncKey(event.spriteKey);
                        if (target) {
                            isApplyingRemote = true;
                            applyBlocksToTarget(target, JSON.parse(event.blockData));
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
                            console.log(`[Collab 🏷️] Mạng: Đổi tên nhân vật thành ${event.newKey}`);
                            Scratch.vm.renameSprite(target.id, event.newKey);
                            setTimeout(() => { isApplyingRemote = false; }, 50);
                        }
                    }

                    // 3. NHẬN THUỘC TÍNH / TRANG PHỤC CỦA NHÂN VẬT
                    if (event.type === 'SYNC_SPRITE_PROP') {
                        const target = getTargetBySyncKey(event.spriteKey);
                        if (target) {
                            isApplyingRemote = true;
                            try {
                                if (event.prop === 'xy') target.setXY(event.value.x, event.value.y);
                                if (event.prop === 'size') target.setSize(event.value);
                                if (event.prop === 'direction') target.setDirection(event.value);
                                if (event.prop === 'costume') target.setCostume(event.value);
                                
                                // Bắt buộc giao diện (Bảng thông số dưới sân khấu) vẽ lại để thấy sự thay đổi
                                Scratch.vm.emitTargetsUpdate();
                            } finally {
                                setTimeout(() => { isApplyingRemote = false; }, 40);
                            }
                        }
                    }
                });

                room.getStorage().then((storage) => {
                    sharedBlocks = storage.root.get("sharedBlocks");
                    
                    // SỬA LỖI: Đồng bộ code cho TẤT CẢ các sprite đang có trong dự án thay vì chỉ 1 cái
                    for (const target of Scratch.vm.runtime.targets) {
                        const cloudStr = sharedBlocks.get(getSyncKey(target));
                        if (cloudStr) {
                            applyBlocksToTarget(target, JSON.parse(cloudStr));
                        }
                    }
                    Scratch.vm.emitWorkspaceUpdate(); // Cập nhật lại giao diện
                    
                    console.log("[Collab ✅] SẴN SÀNG! ĐÃ TÍCH HỢP ĐỒNG BỘ TRANG PHỤC VÀ SÂN KHẤU!");
                });
                
            } catch (err) {
                console.error("[Collab ❌] LỖI:", err);
            }
        }
    }

    Scratch.extensions.register(new LiveblocksCollab());
})(Scratch);