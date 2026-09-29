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
    let currentRoomId = null;
    let myUserName = localStorage.getItem('collab_username') || ('User_' + Math.floor(1000 + Math.random() * 9000));
    let cursorsContainer = null;
    let cursorElements = new Map();
    let lastMouseTime = 0;
    let navBarBadgeEl = null;

    let sharedBlocks = null; 
    let remoteOpDepth = 0; // Bộ đếm độ sâu ngữ cảnh từ xa (Chống xung đột đa luồng)
    function isRemoteActive() { return remoteOpDepth > 0; }
    function enterRemoteScope() { remoteOpDepth++; }
    function exitRemoteScope() { remoteOpDepth = Math.max(0, remoteOpDepth - 1); }

    let isCostumeLocked = false;
    const incomingTransfers = new Map();
    const handledActionIds = new Set(); // Bộ nhớ cache ngăn chặn lặp gói tin thêm/xóa Sprite

    // --- HỆ THỐNG AN TOÀN CHỐNG MẤT DỮ LIỆU & BỘ NHỚ ---
    const localBackups = new Map();
    const spriteVersions = new Map();
    const blockSyncDebounceTimers = new Map();
    let activeCostumeLockTimeout = null;
    let liveCostumeSyncInterval = null;
    let lastSentCostumeDataURI = null;
    let loadingOverlayEl = null;

    // TỰ ĐỘNG DỌN DẸP RÁC LOCALSTORAGE CŨ
    function cleanupAllLocalBackups() {
        try {
            const keysToRemove = [];
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (k && k.startsWith('collab_backup_')) keysToRemove.push(k);
            }
            keysToRemove.forEach(k => localStorage.removeItem(k));
        } catch (e) {
            console.warn("[Collab] Lỗi dọn cache localStorage:", e);
        }
    }
    cleanupAllLocalBackups(); // Dọn ngay khi extension vừa nạp

    // MÀN HÌNH LOADING CHẶN THAO TÁC CHO ĐẾN KHI NẠP ĐỦ DỮ LIỆU
    function showLoadingScreen(title = 'Đang đồng bộ phòng...', subtitle = 'Vui lòng chờ...', percent = 0) {
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
        setTimeout(() => {
            if (loadingOverlayEl) loadingOverlayEl.style.display = 'none';
        }, 250);
    }

    // --- HỆ THỐNG CHAT & GIAO DIỆN TURBOWARP ---
    let chatDrawerEl = null;
    let chatToggleBtnEl = null;
    let chatMessages = [];
    let isChatOpen = false;
    let unreadCount = 0;

    // BỘ ICON SVG VECTOR CHUẨN TURBOWARP (KHÔNG DÙNG EMOJI)
    const ICONS = {
        users: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>`,
        exit: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path><polyline points="16 17 21 12 16 7"></polyline><line x1="21" y1="12" x2="9" y2="12"></line></svg>`,
        chat: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>`,
        send: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>`,
        lock: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#ff4d4f" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>`,
        close: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`
    };

    // KIỂM TRA CHÍNH XÁC XEM CÓ ĐANG Ở TAB VẼ TRANG PHỤC KHÔNG
    function isCostumeTabActive() {
        const tabs = document.querySelectorAll('[class*="react-tabs__tab"], [role="tab"]');
        for (const tab of tabs) {
            const isSelected = tab.getAttribute('aria-selected') === 'true' || 
                               tab.classList.contains('react-tabs__tab--selected') ||
                               tab.className.includes('is-selected');
            if (isSelected) {
                const text = (tab.textContent || '').trim().toLowerCase();
                if (text.includes('costume') || text.includes('trang phục') || text.includes('backdrop') || text.includes('phông nền')) {
                    return true;
                }
            }
        }
        const paintEditor = document.querySelector('[class*="paint-editor_paint-editor"]') ||
                            document.querySelector('[class*="paint-editor_canvas-container"]');
        return !!(paintEditor && paintEditor.offsetParent !== null && paintEditor.getBoundingClientRect().width > 0);
    }

    const DANV_LOGO_URL = 'https://github.com/danvPR/workshop/blob/main/Assets/Logo-Vi.png?raw=true';

    // THANH ĐIỀU KHIỂN TRÊN NAVIGATION BAR (TỰ ĐỘNG HIỂN THỊ NÚT BẤM KẾT NỐI / THOÁT)
    function updateNavBarBadge(roomId, onlineCount = 1) {
        const navBar = document.querySelector('[class*="menu-bar_account-info-group"]') ||
                       document.querySelector('[class*="menu-bar_main-menu"]');
        if (!navBar) return;

        if (!navBarBadgeEl) {
            navBarBadgeEl = document.createElement('div');
            navBarBadgeEl.id = 'collab-navbar-badge';
            navBar.prepend(navBarBadgeEl);
        }

        // Trường hợp 1: Chưa kết nối phòng -> Hiển thị nút bấm "Kết nối"
        if (!roomId) {
            navBarBadgeEl.style.cssText = `
                display: inline-flex; align-items: center; gap: 6px;
                background: #4C97FF; padding: 4px 12px; border-radius: 5px; color: #ffffff;
                font-size: 12px; font-weight: 600; font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
                cursor: pointer; user-select: none; margin: 0 6px; transition: background 0.15s ease;
            `;
            navBarBadgeEl.title = 'Bấm để kết nối phòng cộng tác';
            navBarBadgeEl.innerHTML = `
                <img src="${DANV_LOGO_URL}" style="height: 14px; width: auto; object-fit: contain;" />
                <span>Kết nối phòng</span>
            `;
            navBarBadgeEl.onmouseenter = () => { navBarBadgeEl.style.background = '#3373CC'; };
            navBarBadgeEl.onmouseleave = () => { navBarBadgeEl.style.background = '#4C97FF'; };
            navBarBadgeEl.onclick = () => {
                if (window.collabInstance) window.collabInstance.openModalBlock();
            };
            return;
        }

        // Trường hợp 2: Đã kết nối -> Hiển thị thông tin phòng, Chat và nút Thoát
        navBarBadgeEl.style.cssText = `
            display: inline-flex; align-items: center; gap: 8px;
            background: hsla(215, 100%, 65%, 0.15);
            border: 1px solid hsla(215, 100%, 65%, 0.35);
            padding: 4px 10px; border-radius: 6px; color: #ffffff;
            font-size: 12px; font-weight: 500; font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
            user-select: none; margin: 0 6px;
        `;

        navBarBadgeEl.innerHTML = `
            <span style="display:inline-block; width:7px; height:7px; border-radius:50%; background:#2fd67c;"></span>
            <span id="collab-badge-copy" title="Bấm để sao chép mã phòng" style="cursor:pointer; display:flex; align-items:center; gap:4px;">
                Phòng: <strong style="color:#4C97FF;">${roomId}</strong>
            </span>
            <span style="display:inline-flex; align-items:center; gap:3px; background:rgba(0,0,0,0.25); padding:2px 6px; border-radius:4px; font-size:11px;">
                ${ICONS.users} ${onlineCount}
            </span>
            <button id="collab-badge-chat-btn" title="Mở bảng trò chuyện" style="
                background: rgba(76, 151, 255, 0.2); border: none; border-radius: 4px; padding: 3px 6px;
                cursor: pointer; color: #fff; display: flex; align-items: center; justify-content: center;
            ">${ICONS.chat}</button>
            <button id="collab-badge-leave-btn" title="Thoát phòng" style="
                background: rgba(255, 77, 79, 0.2); border: none; border-radius: 4px; padding: 3px 6px;
                cursor: pointer; color: #ff7875; display: flex; align-items: center; justify-content: center;
            ">${ICONS.exit}</button>
        `;

        const copyBtn = navBarBadgeEl.querySelector('#collab-badge-copy');
        if (copyBtn) {
            copyBtn.onclick = () => {
                navigator.clipboard.writeText(roomId).then(() => {
                    showCostumeLock(`Đã sao chép mã phòng "${roomId}"`);
                    setTimeout(() => { if (!isCostumeLocked) hideCostumeLock(); }, 2000);
                });
            };
        }

        const chatBtn = navBarBadgeEl.querySelector('#collab-badge-chat-btn');
        if (chatBtn) chatBtn.onclick = () => toggleChatUI();

        const leaveBtn = navBarBadgeEl.querySelector('#collab-badge-leave-btn');
        if (leaveBtn) {
            leaveBtn.onclick = () => {
                if (confirm('Bạn có chắc muốn thoát khỏi phòng cộng tác này?')) {
                    leaveCollabRoom();
                }
            };
        }
    }

    // MODAL HỎI ID PHÒNG CÓ LOGO DANVWORKSHOP
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
                <div style="
                    background: #252839; border: 1px solid rgba(255, 255, 255, 0.15);
                    border-radius: 8px; width: 360px; padding: 22px;
                    box-shadow: 0 8px 30px rgba(0, 0, 0, 0.4); color: #fff;
                ">
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 16px;">
                        <div style="display:flex; align-items:center; gap:8px;">
                            <img src="${DANV_LOGO_URL}" style="height: 22px; width: auto; object-fit: contain;" alt="DANV" />
                            <span style="font-size: 15px; font-weight: 600; color: #fff;">DANV Collab</span>
                        </div>
                        <div id="collab-modal-close" style="cursor:pointer; color:#858ca0;">${ICONS.close}</div>
                    </div>

                    <div style="margin-bottom: 14px;">
                        <label style="display: block; font-size: 12px; color: #b8bfd3; margin-bottom: 5px;">Tên hiển thị</label>
                        <input id="collab-input-name" type="text" value="${myUserName}" placeholder="Nhập tên..." style="
                            width: 100%; box-sizing: border-box; background: #1b1d28;
                            border: 1px solid rgba(255,255,255,0.2); border-radius: 5px; padding: 8px 12px;
                            color: #fff; font-size: 13px; outline: none;
                        " />
                    </div>

                    <div style="margin-bottom: 20px;">
                        <label style="display: block; font-size: 12px; color: #b8bfd3; margin-bottom: 5px;">Mã phòng</label>
                        <input id="collab-input-room" type="text" value="${defaultRoomId}" placeholder="Ví dụ: phong-chinh-1" style="
                            width: 100%; box-sizing: border-box; background: #1b1d28;
                            border: 1px solid rgba(255,255,255,0.2); border-radius: 5px; padding: 8px 12px;
                            color: #4C97FF; font-weight: 600; font-size: 13px; outline: none;
                        " />
                    </div>

                    <div style="display: flex; gap: 8px; justify-content: flex-end;">
                        <button id="collab-btn-cancel" style="
                            background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.15); padding: 7px 16px; border-radius: 5px;
                            color: #fff; font-size: 12px; cursor: pointer;
                        ">Hủy</button>
                        <button id="collab-btn-confirm" style="
                            background: #4C97FF; border: none; padding: 7px 18px; border-radius: 5px;
                            color: #fff; font-size: 12px; font-weight: 600; cursor: pointer;
                        ">Tham gia</button>
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

    // --- HỆ THỐNG TRÒ CHUYỆN (CHAT DRAWER) THEO GIAO DIỆN TURBOWARP ---
    function setupChatUI() {
        if (!chatToggleBtnEl) {
            chatToggleBtnEl = document.createElement('div');
            chatToggleBtnEl.id = 'collab-chat-toggle-btn';
            chatToggleBtnEl.style.cssText = `
                position: fixed; bottom: 20px; right: 20px;
                width: 44px; height: 44px; border-radius: 50%;
                background: #4C97FF; color: #fff;
                display: flex; align-items: center; justify-content: center;
                cursor: pointer; z-index: 999998; box-shadow: 0 4px 14px rgba(0,0,0,0.3);
                user-select: none; transition: transform 0.15s ease;
            `;
            chatToggleBtnEl.title = 'Trò chuyện';
            chatToggleBtnEl.innerHTML = `
                ${ICONS.chat}
                <span id="collab-chat-unread" style="
                    display: none; position: absolute; top: -3px; right: -3px;
                    background: #ff4d4f; color: #fff; border-radius: 10px;
                    padding: 1px 5px; font-size: 10px; font-weight: bold; border: 2px solid #1b1d28;
                ">0</span>
            `;
            chatToggleBtnEl.onclick = () => toggleChatUI();
            document.body.appendChild(chatToggleBtnEl);
        }

        if (!chatDrawerEl) {
            chatDrawerEl = document.createElement('div');
            chatDrawerEl.id = 'collab-chat-drawer';
            chatDrawerEl.style.cssText = `
                position: fixed; bottom: 74px; right: 20px; width: 310px; height: 380px;
                background: #252839; border: 1px solid rgba(255,255,255,0.15);
                border-radius: 8px; box-shadow: 0 8px 30px rgba(0,0,0,0.45);
                display: none; flex-direction: column; z-index: 999998;
                font-family: "Helvetica Neue", Helvetica, Arial, sans-serif; overflow: hidden;
            `;

            chatDrawerEl.innerHTML = `
                <div style="background:#1e202c; padding:10px 14px; border-bottom:1px solid rgba(255,255,255,0.1); display:flex; justify-content:space-between; align-items:center;">
                    <span style="font-size:13px; font-weight:600; color:#fff; display:flex; align-items:center; gap:6px;">
                        ${ICONS.chat} Trò chuyện
                    </span>
                    <div id="collab-chat-close-btn" style="cursor:pointer; color:#858ca0;">${ICONS.close}</div>
                </div>
                <div id="collab-chat-messages" style="flex:1; overflow-y:auto; padding:12px; display:flex; flex-direction:column; gap:8px;"></div>
                <div style="padding:8px 10px; background:#1e202c; border-top:1px solid rgba(255,255,255,0.1); display:flex; gap:6px;">
                    <input id="collab-chat-input" type="text" placeholder="Nhập tin nhắn..." style="
                        flex:1; background:#141620; border:1px solid rgba(255,255,255,0.15);
                        border-radius:4px; padding:6px 10px; color:#fff; font-size:12px; outline:none;
                    " />
                    <button id="collab-chat-send-btn" style="
                        background:#4C97FF; border:none; border-radius:4px; padding:6px 10px;
                        color:#fff; cursor:pointer; display:flex; align-items:center; justify-content:center;
                    ">${ICONS.send}</button>
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
        const msg = {
            type: 'CHAT_MESSAGE',
            sender: myUserName,
            text: text,
            time: Date.now()
        };
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

        const isMe = msg.sender === myUserName;
        const timeStr = new Date(msg.time || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

        const row = document.createElement('div');
        row.style.cssText = `
            display: flex; flex-direction: column;
            align-items: ${isMe ? 'flex-end' : 'flex-start'};
        `;

        row.innerHTML = `
            <span style="font-size: 10.5px; color: #858ca0; margin-bottom: 2px;">
                ${isMe ? 'Bạn' : msg.sender} • ${timeStr}
            </span>
            <div style="
                background: ${isMe ? '#4C97FF' : '#33374b'}; color: #fff;
                padding: 6px 10px; border-radius: 6px; font-size: 12px;
                max-width: 80%; word-break: break-word; line-height: 1.35;
            ">${msg.text.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</div>
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

    // THOÁT PHÒNG VÀ DỌN DẸP SẠCH GIAO DIỆN
    function leaveCollabRoom() {
        if (!room) return;
        try {
            releaseCostumeLock();
            client.leave(currentRoomId);
        } catch (e) {
            console.warn("[Collab] Lỗi thoát phòng:", e);
        }

        room = null;
        currentRoomId = null;
        remoteOpDepth = 0;
        handledActionIds.clear();

        // XÓA SẠCH DỮ LIỆU TẠM TRÊN TRÌNH DUYỆT (CHỐNG RÒ RỈ DỮ LIỆU)
        cleanupAllLocalBackups();
        hideLoadingScreen();

        // Đưa nút trên Navigation Bar trở về trạng thái "Kết nối phòng"
        updateNavBarBadge(null);

        destroyChatUI();

        for (const [id, el] of cursorElements) el.remove();
        cursorElements.clear();

        updateDOMCostumeCurtain(false);
        hideCostumeLock();

        showCostumeLock('Đã rời khỏi phòng cộng tác');
        setTimeout(() => hideCostumeLock(), 2500);
    }

    // KIỂM TRA QUYỀN SỬA TRANG PHỤC
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
            editingCostume: {
                spriteKey: spriteKey,
                costumeIndex: costumeIndex,
                timestamp: Date.now()
            }
        });

        if (!liveCostumeSyncInterval) {
            liveCostumeSyncInterval = setInterval(() => {
                sendLiveCostumeSync();
            }, 5000);
        }

        if (activeCostumeLockTimeout) clearTimeout(activeCostumeLockTimeout);
        activeCostumeLockTimeout = setTimeout(() => {
            releaseCostumeLock();
        }, 8000);
    }

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

    // MÀN CHẮN TRANG PHỤC TURBOWARP (TỰ ẨN 100% KHI THOÁT KHỎI TAB COSTUME)
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
            position: fixed;
            top: ${rect.top}px;
            left: ${rect.left}px;
            width: ${rect.width}px;
            height: ${rect.height}px;
            background: rgba(20, 22, 33, 0.75);
            z-index: 99999;
            display: flex;
            align-items: center;
            justify-content: center;
            color: white;
            cursor: not-allowed;
            pointer-events: all;
            user-select: none;
            font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
        `;

        paintCurtainEl.innerHTML = `
            <div style="
                background: #252839; padding: 20px 28px; border-radius: 8px;
                border: 1px solid rgba(255, 77, 79, 0.4); box-shadow: 0 10px 30px rgba(0,0,0,0.5);
                text-align: center; pointer-events: none; max-width: 320px;
            ">
                <div style="display:flex; justify-content:center; margin-bottom:8px;">${ICONS.lock}</div>
                <div style="font-size: 14px; font-weight: 600; color: #ff7875; margin-bottom: 6px;">Khu vực vẽ đang bị khóa</div>
                <div style="font-size: 12.5px; color: #e2e8f0; line-height: 1.4;"><strong style="color:#4C97FF;">${editorName}</strong> đang trực tiếp chỉnh sửa trang phục này.</div>
                <div style="font-size: 11px; color: #858ca0; margin-top: 10px; border-top: 1px solid rgba(255,255,255,0.08); padding-top: 8px;">
                    Các nét vẽ sẽ tự động cập nhật thời gian thực
                </div>
            </div>
        `;
    }

    // THÔNG BÁO TOAST GÓC MÀN HÌNH THEO ĐÚNG PHONG CÁCH TURBOWARP
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
                z-index: 1000000; display: flex; align-items: center; gap: 10px;
                font-size: 12.5px; pointer-events: none; transition: opacity 0.2s, transform 0.2s;
            `;
            document.body.appendChild(lockOverlay);
        }
        lockOverlay.innerHTML = `<span>${message}</span>`;
        lockOverlay.style.opacity = '1';
        lockOverlay.style.transform = 'translateY(0)';
    }

    function hideCostumeLock() {
        if (lockOverlay) {
            lockOverlay.style.opacity = '0';
            lockOverlay.style.transform = 'translateY(10px)';
        }
    }

    // LẮNG NGHE ĐỔI TAB VÀ SỰ KIỆN CLICK CHUỘT
    function setupCostumeInteractionListeners() {
        const handleInteraction = (e) => {
            if (!room || isApplyingRemote) return;
            const target = Scratch.vm.editingTarget;
            if (!target) return;

            const inPaintArea = e.target.closest && (
                e.target.closest('[class*="paint-editor_"]') || 
                e.target.closest('[class*="asset-panel_"]')
            );
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

        const costumeObj = {
            name: costumeData.name,
            dataFormat: costumeData.dataFormat,
            asset: asset,
            assetId: costumeData.assetId,
            md5: costumeData.md5ext || `${costumeData.assetId}.${costumeData.dataFormat}`,
            rotationCenterX: costumeData.rotationCenterX,
            rotationCenterY: costumeData.rotationCenterY,
            bitmapResolution: costumeData.bitmapResolution || 1,
            size: [0, 0] // Mặc định để chống lỗi Cannot read properties of undefined (reading 'size')
        };

        // Đăng ký Skin mới với WebGL Renderer để nhân vật hiển thị lại trên sân khấu
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
                console.warn("[Collab] Chưa thể tạo WebGL Skin ngay:", err);
            }
        }

        return costumeObj;
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

        // 8. Đồng bộ Vẽ Vector SVG (Hook vào Scratch.vm thay vì targetProto)
        const originalVMUpdateSvg = Scratch.vm.updateSvg;
        Scratch.vm.updateSvg = function(costumeIndex, svg, rotationCenterX, rotationCenterY) {
            const target = Scratch.vm.editingTarget;
            const syncKey = target ? getSyncKey(target) : null;
            if (!isApplyingRemote && syncKey) {
                const editor = getOtherCostumeEditor(syncKey, costumeIndex);
                if (editor) {
                    showCostumeLock(`🔒 ${editor.userName} đang vẽ trang phục này!`);
                    return;
                }
                acquireCostumeLock(syncKey, costumeIndex);
            }

            const result = originalVMUpdateSvg.call(this, costumeIndex, svg, rotationCenterX, rotationCenterY);
            if (!isApplyingRemote && room && syncKey) {
                sendChunkedPayload('SYNC_UPDATE_SVG', syncKey, {
                    costumeIndex, svg, rotationCenterX, rotationCenterY
                });
            }
            return result;
        };

        // 9. Đồng bộ Vẽ Bitmap Pixel (Hook vào Scratch.vm thay vì targetProto)
        const originalVMUpdateBitmap = Scratch.vm.updateBitmap;
        Scratch.vm.updateBitmap = function(costumeIndex, bitmap, rotationCenterX, rotationCenterY) {
            const target = Scratch.vm.editingTarget;
            const syncKey = target ? getSyncKey(target) : null;
            if (!isApplyingRemote && syncKey) {
                const editor = getOtherCostumeEditor(syncKey, costumeIndex);
                if (editor) {
                    showCostumeLock(`🔒 ${editor.userName} đang vẽ trang phục này!`);
                    return;
                }
                acquireCostumeLock(syncKey, costumeIndex);
            }

            const result = originalVMUpdateBitmap.call(this, costumeIndex, bitmap, rotationCenterX, rotationCenterY);
            if (!isApplyingRemote && room && syncKey) {
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
            if (isRemoteActive() || !room) return;
            if (e.isRemote || e.type === 'ui') return;

            const SYNC_EVENTS = [
                'create', 'delete', 'move', 'change',
                'comment_create', 'comment_change', 'comment_move', 'comment_delete'
            ];

            if (SYNC_EVENTS.includes(e.type)) {
                let target = null;
                for (const t of Scratch.vm.runtime.targets) {
                    if (t.blocks === this) { target = t; break; }
                }
                if (!target) return;

                const syncKey = getSyncKey(target);
                const blocksRef = this._blocks;
                const commentsRef = this._comments;

                // DEBOUNCE 90ms: Tránh spam hàng chục gói tin khổng lồ khi nhấp nhả hoặc rê chuột
                if (blockSyncDebounceTimers.has(syncKey)) {
                    clearTimeout(blockSyncDebounceTimers.get(syncKey));
                }

                blockSyncDebounceTimers.set(syncKey, setTimeout(() => {
                    blockSyncDebounceTimers.delete(syncKey);
                    if (!room || isRemoteActive()) return;

                    const newVersion = (spriteVersions.get(syncKey) || 0) + 1;
                    spriteVersions.set(syncKey, newVersion);

                    const payload = {
                        blocks: blocksRef,
                        comments: commentsRef,
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
                }, 90));
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

        // 2. Tạo Sprite mới (Gắn actionId triệt tiêu vòng lặp phản hồi)
        const originalAddSprite = Scratch.vm.addSprite;
        Scratch.vm.addSprite = async function(input) {
            const isLocal = !isRemoteActive();
            const result = await originalAddSprite.call(this, input);
            if (isLocal && room) {
                const newTarget = (result && result.id ? result : (Array.isArray(result) ? result[0] : null)) 
                    || Scratch.vm.runtime.targets[Scratch.vm.runtime.targets.length - 1];

                if (newTarget && !newTarget.isStage) {
                    try {
                        const targetJSON = newTarget.toJSON();
                        targetJSON.blocks = {};
                        targetJSON.sounds = [];
                        const serializedCostumes = (newTarget.sprite.costumes || []).map(serializeCostume);
                        const actionId = 'act_add_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);
                        handledActionIds.add(actionId);

                        sendChunkedPayload('SYNC_NEW_SPRITE', getSyncKey(newTarget), {
                            actionId: actionId,
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

        // 3. Nhân bản Sprite
        const originalDuplicateSprite = Scratch.vm.duplicateSprite;
        Scratch.vm.duplicateSprite = async function(targetId) {
            const isLocal = !isRemoteActive();
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
                        const actionId = 'act_dup_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);
                        handledActionIds.add(actionId);

                        sendChunkedPayload('SYNC_NEW_SPRITE', getSyncKey(newTarget), {
                            actionId: actionId,
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

        // 4. Xóa Sprite (Gắn actionId triệt tiêu xóa ngược)
        const originalDeleteSprite = Scratch.vm.deleteSprite;
        Scratch.vm.deleteSprite = function(targetId) {
            const target = Scratch.vm.runtime.getTargetById(targetId);
            const syncKey = target ? getSyncKey(target) : null;
            const isLocal = !isRemoteActive();
            
            const result = originalDeleteSprite.call(this, targetId);
            if (isLocal && room && syncKey) {
                const actionId = 'act_del_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);
                handledActionIds.add(actionId);
                room.broadcastEvent({ type: 'SYNC_DELETE_SPRITE', actionId: actionId, spriteKey: syncKey });
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
        constructor() {
            window.collabInstance = this;
            // Tự động gắn nút "Kết nối phòng" lên thanh Navigation bar khi khởi tạo
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
                    {
                        blockType: Scratch.BlockType.BUTTON,
                        text: 'Kết nối phòng',
                        func: 'openModalBlock'
                    },
                    {
                        blockType: Scratch.BlockType.BUTTON,
                        text: 'Thoát phòng',
                        func: 'leaveRoomBlock'
                    }
                ]
            };
        }

        async openModalBlock() {
            if (room) {
                alert(`Bạn đang ở trong phòng "${currentRoomId}". Hãy thoát phòng trước nếu muốn đổi phòng!`);
                return;
            }
            const modalResult = await openCollabJoinModal('phong-test-1');
            if (modalResult) {
                this.startRoomConnection(modalResult.roomId, modalResult.userName);
            }
        }

        leaveRoomBlock() {
            if (!room) {
                alert('Bạn hiện chưa tham gia phòng nào!');
                return;
            }
            leaveCollabRoom();
        }

        startRoomConnection(roomId, userName) {
            if (room) return;
            currentRoomId = roomId;
            myUserName = userName;

            console.log(`[Collab] Đang kết nối phòng: ${roomId} với tên: ${userName}...`);
            
            // KÍCH HOẠT MÀN HÌNH LOADING CHẶN THAO TÁC CỦA NGƯỜI DÙNG
            showLoadingScreen(`Đang kết nối [${roomId}]`, 'Đang thiết lập kênh trực tiếp...', 15);

            setupDOM();
            setupVMHooks();
            setupSpriteHooks();
            setupCostumeInteractionListeners();

            updateNavBarBadge(roomId, 1);
            setupChatUI();

            try {
                const response = client.enterRoom(roomId, {
                    initialPresence: { 
                        cursor: null, 
                        editingCostume: null,
                        name: myUserName 
                    },
                    initialStorage: { sharedBlocks: new LiveMap() }
                });
                
                room = response.room;
                updateLoadingProgress(`Đang vào phòng [${roomId}]`, 'Đang kết nối Liveblocks Room...', 45);

                document.addEventListener('mousemove', (e) => {
                    if (Date.now() - lastMouseTime > 50) {
                        room.updatePresence({ cursor: { x: e.clientX, y: e.clientY }, name: myUserName });
                        lastMouseTime = Date.now();
                    }
                });

                room.subscribe("others", () => {
                    const others = room.getOthers();
                    const activeIds = new Set();
                    let someoneEditingCurrentCostume = false;
                    let currentEditorName = "Người dùng khác";

                    updateNavBarBadge(currentRoomId, others.length + 1);

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
                                el.style.cssText = `position:absolute; width:13px; height:13px; background:#4C97FF; border:2px solid #fff; border-radius:50%; transform:translate(-50%,-50%); transition: left 0.1s linear, top 0.1s linear; box-shadow: 0 2px 4px rgba(0,0,0,0.4); pointer-events: none; z-index: 999999;`;
                                cursorsContainer.appendChild(el);
                                cursorElements.set(cid, el);
                            }
                            el.style.left = p.cursor.x + 'px'; el.style.top = p.cursor.y + 'px';
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

                    // CHỈ HIỆN KHI ĐANG MỞ TAB COSTUMES
                    if (isCostumeTabActive()) {
                        updateDOMCostumeCurtain(someoneEditingCurrentCostume, currentEditorName);
                        if (someoneEditingCurrentCostume) {
                            showCostumeLock(`${currentEditorName} đang vẽ trang phục này...`);
                        } else if (!isCostumeLocked) {
                            hideCostumeLock();
                        }
                    } else {
                        if (paintCurtainEl) paintCurtainEl.style.display = 'none';
                        if (!isCostumeLocked) hideCostumeLock();
                    }

                    for (const [id, el] of cursorElements) {
                        if (!activeIds.has(id)) { el.remove(); cursorElements.delete(id); }
                    }
                });

                room.subscribe("event", ({ event }) => {
                    // NHẬN TIN NHẮN CHAT TỪ THÀNH VIÊN KHÁC
                    if (event.type === 'CHAT_MESSAGE') {
                        appendChatMessage(event);
                    }

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
                                                    const currentCostume = target.sprite && target.sprite.costumes[data.costumeIndex];
                                                    if (costumeObj && currentCostume) {
                                                        // Giữ lại skinId cũ nếu có để tránh crash
                                                        if (!costumeObj.skinId && currentCostume.skinId) {
                                                            costumeObj.skinId = currentCostume.skinId;
                                                        }
                                                        if (!costumeObj.size && currentCostume.size) {
                                                            costumeObj.size = currentCostume.size;
                                                        }

                                                        target.sprite.costumes[data.costumeIndex] = costumeObj;

                                                        // Cập nhật lại hình trên sân khấu
                                                        if (target.renderer && costumeObj.skinId) {
                                                            target.updateAllDrawableProperties();
                                                        }

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

                                    // 4. NHẬN TẠO SPRITE MỚI QUA CHUNKING (CHỐNG VÒNG LẶP TUYỆT ĐỐI)
                                    if (session.action === 'SYNC_NEW_SPRITE') {
                                        if (data.actionId && handledActionIds.has(data.actionId)) {
                                            console.log("[Collab] Bỏ qua sprite đã tự tạo cục bộ:", data.actionId);
                                        } else {
                                            if (data.actionId) handledActionIds.add(data.actionId);
                                            enterRemoteScope();
                                            (async () => {
                                                try {
                                                    if (data.costumes && Array.isArray(data.costumes)) {
                                                        for (const c of data.costumes) await deserializeCostume(c);
                                                    }

                                                    // Xóa sprite cũ trùng tên trong chế độ im lặng tuyệt đối (không kích hoạt hook ngược)
                                                    const duplicateOld = getTargetBySyncKey(session.spriteKey);
                                                    if (duplicateOld && !duplicateOld.isStage) {
                                                        Scratch.vm.deleteSprite(duplicateOld.id);
                                                    }

                                                    const added = await Scratch.vm.addSprite(data.spriteJSON);
                                                    const addedTarget = (added && added.id ? added : (Array.isArray(added) ? added[0] : null)) 
                                                        || Scratch.vm.runtime.targets[Scratch.vm.runtime.targets.length - 1];

                                                    if (addedTarget && addedTarget.sprite && addedTarget.sprite.name !== session.spriteKey) {
                                                        addedTarget.sprite.name = session.spriteKey;
                                                    }

                                                    Scratch.vm.emitTargetsUpdate();
                                                    Scratch.vm.emitWorkspaceUpdate();
                                                } catch (err) {
                                                    console.error("[Collab ❌] Lỗi tạo sprite từ chunk:", err);
                                                } finally {
                                                    exitRemoteScope();
                                                }
                                            })();
                                        }
                                    }

                                } catch (err) {
                                    console.error("[Collab ❌] Lỗi ghép mảnh dữ liệu:", err);
                                } finally {
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
                            enterRemoteScope();
                            try {
                                target.deleteCostume(event.index);
                                Scratch.vm.emitTargetsUpdate();
                            } finally {
                                exitRemoteScope();
                            }
                        }
                    }

                    // NHẬN ĐỔI TÊN TRANG PHỤC
                    if (event.type === 'SYNC_RENAME_COSTUME') {
                        const target = getTargetBySyncKey(event.spriteKey);
                        if (target && target.sprite && target.sprite.costumes[event.costumeIndex]) {
                            enterRemoteScope();
                            try {
                                target.renameCostume(event.costumeIndex, event.newName);
                                Scratch.vm.emitTargetsUpdate();
                            } finally {
                                exitRemoteScope();
                            }
                        }
                    }

                    // 10. NHẬN XÓA SPRITE (CHỐNG PHẢN HỒI NGƯỢC LẠI)
                    if (event.type === 'SYNC_DELETE_SPRITE') {
                        if (event.actionId && handledActionIds.has(event.actionId)) {
                            console.log("[Collab] Bỏ qua lệnh xóa do chính mình gửi đi");
                        } else {
                            if (event.actionId) handledActionIds.add(event.actionId);
                            const target = getTargetBySyncKey(event.spriteKey);
                            if (target) {
                                enterRemoteScope();
                                try {
                                    Scratch.vm.deleteSprite(target.id);
                                } finally {
                                    exitRemoteScope();
                                }
                            }
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

                room.getStorage().then(async (storage) => {
                    updateLoadingProgress('Tải dữ liệu dự án...', 'Đang nạp cấu trúc khối lệnh...', 75);
                    sharedBlocks = storage.root.get("sharedBlocks");
                    
                    enterRemoteScope();
                    try {
                        const targets = Scratch.vm.runtime.targets || [];
                        for (let i = 0; i < targets.length; i++) {
                            const target = targets[i];
                            const cloudStr = sharedBlocks.get(getSyncKey(target));
                            if (cloudStr) {
                                applyBlocksToTarget(target, JSON.parse(cloudStr));
                            }
                            updateLoadingProgress('Tải dữ liệu dự án...', `Đang đồng bộ [${getSyncKey(target)}]...`, 75 + Math.round(((i + 1) / targets.length) * 20));
                        }
                        Scratch.vm.emitWorkspaceUpdate(); 
                        Scratch.vm.emitTargetsUpdate();
                    } finally {
                        exitRemoteScope();
                    }

                    if (Scratch.vm.extensionManager && Scratch.vm.extensionManager.getExtensionURLs) {
                        const urls = Object.values(Scratch.vm.extensionManager.getExtensionURLs());
                        urls.forEach(url => {
                            room.broadcastEvent({ type: 'SYNC_EXTENSION', url: url });
                        });
                    }

                    updateLoadingProgress('Đã sẵn sàng!', 'Đồng bộ hoàn tất 100%', 100);
                    setTimeout(() => {
                        hideLoadingScreen();
                    }, 400);

                    console.log("[Collab ✅] SẴN SÀNG: Màn hình loading và cơ chế chống lặp sprite đã hoạt động!");
                }).catch(err => {
                    console.error("[Collab] Lỗi tải storage ban đầu:", err);
                    hideLoadingScreen();
                });
                
            } catch (err) {
                console.error("[Collab ❌] LỖI:", err);
            }
        }
    }

    Scratch.extensions.register(new LiveblocksCollab());
})(Scratch);