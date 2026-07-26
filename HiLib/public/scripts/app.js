/**
 * HiLib 前端 Vue 应用
 *
 * 三栏布局：左侧导航 + 中间会话列表 + 右侧聊天窗口
 * 通过 /api/* 与后端交互，后端调用 SPRR 逆向 API。
 */

const { createApp, ref, computed, onMounted, onUnmounted, nextTick, reactive } = Vue;

createApp({
  setup() {
    /* ----------------------------- 状态 ----------------------------- */
    const nav = ref('messages');
    const accounts = ref([]);
    const currentAccount = ref(null);
    const showAccountMenu = ref(false);

    const contacts = ref([]);
    const contactsError = ref('');
    const loadingContacts = ref(false);
    const searchKeyword = ref('');
    const selectedCid = ref(null);
    const selectedContact = computed(() =>
      contacts.value.find((c) => c.conversationId === selectedCid.value) || null,
    );

    const messages = ref([]);
    const messagesError = ref('');
    const loadingMessages = ref(false);
    const msgListRef = ref(null);
    const nextCursor = ref('');
    const hasMoreMessages = ref(false);
    const loadingMoreMessages = ref(false);

    const previewImageUrl = ref('');
    const toast = reactive({ text: '', type: '', timer: null });
    const myProfile = ref(null);

    /** 表情映射表 { '[看]': '/api/emoji/image?name=...', ... } */
    const emojiMap = ref({});
    /** 表情映射表是否已加载 */
    const emojiMapLoaded = ref(false);

    const draftText = ref('');
    const sending = ref(false);

    /** 表情面板是否展开 */
    const emojiPanelOpen = ref(false);
    /** 加号菜单是否展开 */
    const plusMenuOpen = ref(false);
    /** 待发送的图片列表 { dataUrl, name, bytes } */
    const pendingImages = ref([]);
    /** 输入框/文件选择器 ref */
    const messageInputRef = ref(null);
    const imageInputRef = ref(null);
    const fileInputRef = ref(null);

    const loginDialog = reactive({
      mode: '',        // 'qr' | 'cookie' | ''
      name: '',
      cookie: '',
      timeout: 300,
      status: '',      // '' | 'loading' | 'success' | 'error'
      error: '',
    });

    const scanDialog = reactive({
      show: false,
      loading: false,
      error: '',
      accounts: [],
      selected: [],    // 选中的索引数组
    });

    /* ----------------------------- 计算属性 ----------------------------- */
    const totalUnread = computed(() =>
      contacts.value.reduce((sum, c) => sum + (c.unreadCount || 0), 0),
    );

    const filteredContacts = computed(() => {
      const kw = searchKeyword.value.trim().toLowerCase();
      if (!kw) return contacts.value;
      return contacts.value.filter(
        (c) =>
          (c.nickname || '').toLowerCase().includes(kw) ||
          (c.uid || '').includes(kw),
      );
    });

    /* ----------------------------- 工具函数 ----------------------------- */
    async function api(url, options) {
      const res = await fetch(url, options);
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) {
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      return data;
    }

    function showToast(text, type = '') {
      if (toast.timer) clearTimeout(toast.timer);
      toast.text = text;
      toast.type = type;
      toast.timer = setTimeout(() => { toast.text = ''; }, 3000);
    }

    function formatTime(ts) {
      if (!ts) return '';
      const d = new Date(ts);
      const pad = (n) => n.toString().padStart(2, '0');
      return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }

    function formatShortTime(ts) {
      if (!ts) return '';
      const d = new Date(ts);
      const now = new Date();
      const pad = (n) => n.toString().padStart(2, '0');
      if (d.toDateString() === now.toDateString()) {
        return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
      }
      const yesterday = new Date(now);
      yesterday.setDate(now.getDate() - 1);
      if (d.toDateString() === yesterday.toDateString()) {
        return '昨天';
      }
      return `${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
    }

    function formatFullTime(ts) {
      if (!ts) return '';
      return formatTime(ts);
    }

    function formatMsgTime(ts) {
      if (!ts) return '';
      const d = new Date(ts);
      const pad = (n) => n.toString().padStart(2, '0');
      return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }

    function shouldShowTimeDivider(index) {
      if (index === 0) return true;
      const cur = messages.value[index];
      const prev = messages.value[index - 1];
      if (!cur?.timestamp || !prev?.timestamp) return false;
      return cur.timestamp - prev.timestamp > 5 * 60 * 1000;
    }

    function msgRowClass(m) {
      if (m.category === 'system_tip' || m.category === 'recall') return 'system';
      if (m.isFromRobot) return 'robot';
      return m.isSelf ? 'self' : '';
    }

    function msgBubbleClass(m) {
      const cls = [];
      if (m.category === 'system_tip' || m.category === 'recall') cls.push('system');
      else if (m.isFromRobot) cls.push('robot');
      else if (m.isSelf) cls.push('self');
      return cls;
    }

    function msgAvatarClass(m) {
      if (m.category === 'system_tip' || m.category === 'recall') return 'system';
      if (m.isFromRobot) return 'robot';
      return m.isSelf ? 'self' : '';
    }

    function msgAvatarText(m) {
      if (m.category === 'system_tip' || m.category === 'recall') return '系';
      if (m.isFromRobot) return 'AI';
      if (m.isSelf) return myProfile.value?.nickname?.[0]?.toUpperCase() || '我';
      // 对方：取选中联系人昵称首字母
      const name = selectedContact.value?.nickname || '?';
      return name[0].toUpperCase();
    }

    /** 消息状态标签文本 */
    function msgTagText(m) {
      if (m.isEncryptedImage) {
        if (m.isPermanent) return m.decrypted ? '永久已读' : '永久未读';
        return m.decrypted ? '一次性已读' : '一次性未读';
      }
      if (m.category === 'recall') return '撤回';
      if (m.category === 'video_share') return '视频';
      if (m.category === 'sticker') return '表情';
      if (m.category === 'image') return '图片';
      if (m.category === 'system_tip') return '系统';
      if (m.isFromRobot) return 'AI';
      return '文本';
    }

    /** 消息状态标签样式类 */
    function msgTagClass(m) {
      if (m.isEncryptedImage) {
        if (m.isPermanent) return m.decrypted ? 'tag-read' : 'tag-permanent';
        return m.decrypted ? 'tag-read' : 'tag-unread';
      }
      if (m.category === 'recall') return 'tag-system';
      if (m.category === 'video_share') return 'tag-video';
      if (m.category === 'sticker') return 'tag-sticker';
      if (m.category === 'image') return 'tag-image';
      if (m.category === 'system_tip') return 'tag-system';
      if (m.isFromRobot) return 'tag-robot';
      return 'tag-text';
    }

    function previewImage(url) {
      previewImageUrl.value = url;
    }

    function loadImageWithFullParams(event, m, cid) {
      const el = event.target;
      if (el.dataset.triedFullParams) return;
      el.dataset.triedFullParams = 'true';

      let fullUrl = `/api/images/get?msgId=${encodeURIComponent(m.msgId)}&cid=${encodeURIComponent(cid)}`;
      if (m.stickerUrl && m.imageSkey) {
        fullUrl += `&url=${encodeURIComponent(m.stickerUrl)}&skey=${encodeURIComponent(m.imageSkey)}`;
      } else if (m.imageOid && m.imageSkey) {
        fullUrl += `&oid=${encodeURIComponent(m.imageOid)}&skey=${encodeURIComponent(m.imageSkey)}`;
      }

      el.src = fullUrl;
      el.onclick = () => previewImage(fullUrl);
    }

    /* ----------------------------- 表情渲染 ----------------------------- */
    /** 加载表情映射表（仅一次） */
    async function loadEmojiMap() {
      if (emojiMapLoaded.value) return;
      try {
        const data = await api('/api/emoji/map');
        emojiMap.value = data || {};
        emojiMapLoaded.value = true;
      } catch {
        // 表情映射加载失败不影响主流程
        emojiMapLoaded.value = true;
      }
    }

    /**
     * 将消息文本中的表情标记（如 [看]）替换为 <img> 图标
     * 先转义 HTML 防止 XSS，再替换映射表中的表情
     */
    function renderEmoji(text) {
      if (!text) return '';
      let result = String(text);
      // 先 HTML 转义，防止注入
      result = result
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
      // 替换映射表中的表情标记为 <img>
      const map = emojiMap.value;
      for (const [name, url] of Object.entries(map)) {
        // 转义正则特殊字符（如 [ ]）
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        result = result.replace(
          new RegExp(escaped, 'g'),
          `<img src="${url}" class="emoji-icon" alt="${name}" loading="lazy" />`,
        );
      }
      return result;
    }

    /* ----------------------------- 账号管理 ----------------------------- */
    async function loadAccounts() {
      try {
        const data = await api('/api/auth/accounts');
        accounts.value = data.accounts || [];
        currentAccount.value = data.current || null;
        await loadMyProfile();
      } catch (e) {
        showToast(`加载账号失败: ${e.message}`, 'error');
      }
    }

    async function loadMyProfile() {
      try {
        const profile = await api('/api/auth/profile');
        myProfile.value = profile || null;
      } catch (e) {
        myProfile.value = null;
      }
    }

    async function switchAccount(name) {
      try {
        await api('/api/auth/use', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name }),
        });
        currentAccount.value = name;
        showAccountMenu.value = false;
        showToast(`已切换到账号: ${name}`, 'success');
        // 切换账号后重新加载会话和自己信息
        contacts.value = [];
        messages.value = [];
        selectedCid.value = null;
        await loadMyProfile();
        await loadContacts();
      } catch (e) {
        showToast(`切换账号失败: ${e.message}`, 'error');
      }
    }

    async function deleteAccount(name) {
      if (!confirm(`确认删除账号 ${name}？\n（仅删除本地登录态，不影响抖音服务器）`)) return;
      try {
        await api(`/api/auth/accounts/${encodeURIComponent(name)}`, { method: 'DELETE' });
        await loadAccounts();
        showToast(`已删除账号: ${name}`, 'success');
        if (currentAccount.value === null) {
          contacts.value = [];
          messages.value = [];
          selectedCid.value = null;
        }
      } catch (e) {
        showToast(`删除失败: ${e.message}`, 'error');
      }
    }

    function openLoginDialog(mode) {
      loginDialog.mode = mode;
      loginDialog.name = '';
      loginDialog.cookie = '';
      loginDialog.timeout = 300;
      loginDialog.status = '';
      loginDialog.error = '';
    }

    function closeLoginDialog() {
      loginDialog.mode = '';
      loginDialog.status = '';
      loginDialog.error = '';
    }

    async function doQrLogin() {
      loginDialog.status = 'loading';
      loginDialog.error = '';
      try {
        const data = await api('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            timeout: loginDialog.timeout * 1000,
          }),
        });
        loginDialog.name = data.name || '';
        loginDialog.status = 'success';
        showToast(`登录成功，账号: ${data.name}`, 'success');
        await loadAccounts();
        // 自动切换到新账号
        if (currentAccount.value !== data.name) {
          await switchAccount(data.name);
        } else {
          await loadContacts();
        }
        setTimeout(() => closeLoginDialog(), 1500);
      } catch (e) {
        loginDialog.status = 'error';
        loginDialog.error = e.message;
      }
    }

    async function doCookieLogin() {
      if (!loginDialog.cookie) {
        showToast('请填写 cookie', 'error');
        return;
      }
      try {
        const data = await api('/api/auth/import-cookie', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: loginDialog.name || undefined,
            cookie: loginDialog.cookie,
          }),
        });
        const accName = data.name || loginDialog.name;
        showToast(`Cookie 导入成功，账号: ${accName}`, 'success');
        await loadAccounts();
        if (currentAccount.value !== accName) {
          await switchAccount(accName);
        } else {
          await loadContacts();
        }
        closeLoginDialog();
      } catch (e) {
        showToast(`导入失败: ${e.message}`, 'error');
      }
    }

    /* --------------------------- 浏览器扫描 --------------------------- */
    async function scanBrowser() {
      scanDialog.show = true;
      scanDialog.loading = true;
      scanDialog.error = '';
      scanDialog.accounts = [];
      scanDialog.selected = [];
      try {
        const data = await api('/api/auth/scan', { method: 'POST' });
        scanDialog.accounts = data.accounts || [];
        // 默认全选
        scanDialog.selected = scanDialog.accounts.map((_, i) => i);
      } catch (e) {
        scanDialog.error = e.message;
      } finally {
        scanDialog.loading = false;
      }
    }

    function closeScanDialog() {
      scanDialog.show = false;
      scanDialog.loading = false;
      scanDialog.error = '';
      scanDialog.accounts = [];
      scanDialog.selected = [];
    }

    function toggleScanSelect(idx) {
      const i = scanDialog.selected.indexOf(idx);
      if (i >= 0) {
        scanDialog.selected.splice(i, 1);
      } else {
        scanDialog.selected.push(idx);
      }
    }

    async function doImportScanned() {
      if (scanDialog.selected.length === 0) return;
      const selectedAccounts = scanDialog.selected.map((i) => scanDialog.accounts[i]);
      try {
        const data = await api('/api/auth/import-scanned', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ accounts: selectedAccounts }),
        });
        const count = data.imported?.length || 0;
        showToast(`成功导入 ${count} 个账号`, 'success');
        closeScanDialog();
        await loadAccounts();
        // 自动切换到第一个导入的账号
        if (data.imported && data.imported.length > 0 && currentAccount.value !== data.imported[0]) {
          await switchAccount(data.imported[0]);
        } else {
          await loadContacts();
        }
      } catch (e) {
        showToast(`导入失败: ${e.message}`, 'error');
      }
    }

    /* ----------------------------- 会话列表 ----------------------------- */
    async function loadContacts() {
      if (!currentAccount.value) {
        contactsError.value = '请先登录账号';
        return;
      }
      contactsError.value = '';

      // 先尝试加载本地缓存（秒回）
      try {
        const cached = await api(`/api/contacts?cached=1&account=${encodeURIComponent(currentAccount.value)}`);
        if (cached.contacts && cached.contacts.length > 0) {
          contacts.value = cached.contacts;
        }
      } catch {
        // 缓存不存在或出错，忽略
      }

      // 从服务器拉取最新数据
      loadingContacts.value = true;
      try {
        const data = await api('/api/contacts');
        if (data.contacts) {
          // 更新列表（TransitionGroup 会自动播放位置变化动画）
          contacts.value = data.contacts;
        }
      } catch (e) {
        if (contacts.value.length === 0) {
          contactsError.value = e.message;
        }
      } finally {
        loadingContacts.value = false;
      }
    }

    /* ----------------------------- 消息历史 ----------------------------- */
    async function selectContact(c) {
      if (selectedCid.value === c.conversationId) return;
      selectedCid.value = c.conversationId;
      messages.value = [];
      nextCursor.value = '';
      hasMoreMessages.value = false;
      await loadMessages();
    }

    /**
     * 加载消息：先从本地缓存秒级显示，再后台拉取服务器最新消息追加
     * 这样切换会话时无需等待转圈，提升响应速度
     */
    async function loadMessages() {
      if (!selectedCid.value) return;
      messagesError.value = '';
      const cid = selectedCid.value;

      // 第一步：先加载本地缓存（无网络请求，秒级响应）
      try {
        const cached = await api(`/api/messages?cid=${encodeURIComponent(cid)}&limit=50&cached=1`);
        if (selectedCid.value !== cid) return; // 已切换到其他会话
        if (cached.messages && cached.messages.length > 0) {
          messages.value = cached.messages;
          await nextTick();
          scrollToBottom();
        }
      } catch {
        // 缓存加载失败忽略，继续走服务器拉取
      }

      // 第二步：后台拉取服务器最新消息
      loadingMessages.value = true;
      try {
        const data = await api(`/api/messages?cid=${encodeURIComponent(cid)}&limit=50`);
        if (selectedCid.value !== cid) return; // 已切换到其他会话

        // 一致性比对：以服务器返回为准，合并新消息
        const serverMsgs = data.messages || [];
        if (serverMsgs.length > 0) {
          // 用 serverMsgId 去重：保留服务器返回的消息 + 本地已有的（服务器可能没返回的）
          const serverIds = new Set(serverMsgs.map((m) => m.serverMsgId || m.msgId));
          const localOnly = messages.value.filter(
            (m) => !serverIds.has(m.serverMsgId || m.msgId),
          );
          // 合并并按时间排序
          const merged = [...serverMsgs, ...localOnly];
          merged.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
          messages.value = merged;
          nextCursor.value = data.nextCursor || '';
          hasMoreMessages.value = data.hasMore || false;
          await nextTick();
          scrollToBottom();
        }

        // 用最新消息时间戳更新会话排序
        updateContactOrderByMessages(serverMsgs);
      } catch (e) {
        messagesError.value = e.message;
      } finally {
        loadingMessages.value = false;
      }
    }

    /** 根据消息列表更新对应联系人的 lastMessageTs 并重新排序 */
    function updateContactOrderByMessages(msgs) {
      if (!msgs || msgs.length === 0 || !selectedCid.value) return;
      const latestMsg = msgs.reduce((a, b) =>
        (a.timestamp || 0) > (b.timestamp || 0) ? a : b,
      );
      if (!latestMsg.timestamp) return;
      const idx = contacts.value.findIndex((c) => c.conversationId === selectedCid.value);
      if (idx < 0) return;
      const c = contacts.value[idx];
      // 仅当新时间戳比已有的更新时才更新（避免翻页加载旧消息时覆盖）
      if (c.lastMessageTs && c.lastMessageTs >= latestMsg.timestamp) return;
      c.lastMessageTs = latestMsg.timestamp;
      if (latestMsg.category === 'recall') c.lastMessage = '[撤回]';
      else if (latestMsg.text) c.lastMessage = latestMsg.text;
      else if (latestMsg.isEncryptedImage) c.lastMessage = '[图片]';
      else if (latestMsg.category === 'video_share') c.lastMessage = '[视频]';
      else if (latestMsg.category === 'sticker') c.lastMessage = '[表情]';
      else if (latestMsg.category === 'image') c.lastMessage = '[图片]';
      // 重新排序（TransitionGroup 自动播放动画）
      sortContactsInPlace();
    }

    /** 对 contacts 就地排序：有 lastMessageTs 的按时间倒序，无的按字母排 */
    function sortContactsInPlace() {
      contacts.value.sort((a, b) => {
        const ta = a.lastMessageTs;
        const tb = b.lastMessageTs;
        if (ta && !tb) return -1;
        if (!ta && tb) return 1;
        if (ta && tb) return tb - ta;
        return (a.nickname || '').localeCompare(b.nickname || '');
      });
    }

    async function loadMoreMessages() {
      if (!selectedCid.value || loadingMoreMessages.value || !hasMoreMessages.value || !nextCursor.value) return;
      loadingMoreMessages.value = true;
      try {
        const data = await api(`/api/messages?cid=${encodeURIComponent(selectedCid.value)}&limit=50&cursor=${encodeURIComponent(nextCursor.value)}`);
        const olderMessages = data.messages || [];
        if (olderMessages.length > 0) {
          // 保持当前滚动位置：记录旧高度，插入后恢复
          const list = msgListRef.value;
          const oldScrollHeight = list ? list.scrollHeight : 0;
          messages.value = [...olderMessages, ...messages.value];
          nextCursor.value = data.nextCursor || '';
          hasMoreMessages.value = data.hasMore || false;
          await nextTick();
          // 恢复滚动位置（让用户看到原来看到的内容）
          if (list) {
            const newScrollHeight = list.scrollHeight;
            list.scrollTop = newScrollHeight - oldScrollHeight;
          }
        } else {
          hasMoreMessages.value = false;
        }
      } catch (e) {
        showToast(`加载更多失败: ${e.message}`, 'error');
      } finally {
        loadingMoreMessages.value = false;
      }
    }

    function onMessagesScroll() {
      const list = msgListRef.value;
      if (!list) return;
      // 滚动到顶部时加载更多
      if (list.scrollTop < 50 && hasMoreMessages.value && !loadingMoreMessages.value) {
        loadMoreMessages();
      }
    }

    async function reloadMessages() {
      nextCursor.value = '';
      hasMoreMessages.value = false;
      await loadMessages();
    }

    async function doSendMessage() {
      const text = getDraftText().trim();
      if (!text || sending.value || !selectedCid.value) return;
      sending.value = true;
      try {
        const data = await api('/api/messages/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cid: selectedCid.value, text }),
        });
        // 发送成功：追加到消息列表
        messages.value.push({
          msgId: data.msgId,
          category: 'text',
          text,
          isSelf: true,
          timestamp: Date.now(),
        });
        // 清空输入框
        if (messageInputRef.value) {
          messageInputRef.value.innerHTML = '';
        }
        draftText.value = '';
        await nextTick();
        scrollToBottom();

        // 更新会话列表排序：把当前会话移到顶部（TransitionGroup 自动播放滑动动画）
        const idx = contacts.value.findIndex((c) => c.conversationId === selectedCid.value);
        if (idx >= 0) {
          const c = contacts.value[idx];
          c.lastMessage = text;
          c.lastMessageTs = Date.now();
          sortContactsInPlace();
        }

        showToast('发送成功', 'success');
      } catch (e) {
        showToast(`发送失败: ${e.message}`, 'error');
      } finally {
        sending.value = false;
      }
    }

    /* ----------------------------- 表情面板 ----------------------------- */
    /** 切换表情面板（同时关闭加号菜单） */
    function toggleEmojiPanel() {
      emojiPanelOpen.value = !emojiPanelOpen.value;
      plusMenuOpen.value = false;
      if (emojiPanelOpen.value) {
        loadEmojiMap();
      }
    }

    /** 从加号菜单打开表情面板 */
    function openEmojiFromPlus() {
      plusMenuOpen.value = false;
      emojiPanelOpen.value = true;
      loadEmojiMap();
    }

    /**
     * 从 contenteditable div 提取纯文本（含 [表情名] 标记）
     * img.emoji-inline 节点转换为 data-emoji 属性值，其余取 textContent
     */
    function getDraftText() {
      const editor = messageInputRef.value;
      if (!editor) return '';
      let text = '';
      for (const node of editor.childNodes) {
        if (node.nodeType === Node.TEXT_NODE) {
          text += node.textContent || '';
        } else if (node.nodeType === Node.ELEMENT_NODE) {
          if (node.tagName === 'IMG' && node.dataset.emoji) {
            text += node.dataset.emoji;
          } else {
            text += node.textContent || '';
          }
        }
      }
      return text;
    }

    /** contenteditable 输入事件：同步纯文本到 draftText */
    function onDraftInput() {
      draftText.value = getDraftText();
    }

    /**
     * 在输入框光标位置插入表情（显示为图片占位符）
     * 抖音会自动把 [表情名] 解析为表情，发送时从 img data-emoji 还原为 [表情名]
     */
    function insertEmoji(name) {
      const editor = messageInputRef.value;
      if (!editor) return;
      editor.focus();

      const url = emojiMap.value[name];
      const img = document.createElement('img');
      if (url) img.src = url;
      img.className = 'emoji-inline';
      img.dataset.emoji = name;
      img.alt = name;
      img.title = name;
      img.draggable = false;

      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0 && editor.contains(sel.anchorNode)) {
        const range = sel.getRangeAt(0);
        range.deleteContents();
        range.insertNode(img);
        range.setStartAfter(img);
        range.setEndAfter(img);
        sel.removeAllRanges();
        sel.addRange(range);
      } else {
        editor.appendChild(img);
      }

      draftText.value = getDraftText();
    }

    /* ----------------------------- 图片发送 ----------------------------- */
    /** 触发图片文件选择器 */
    function pickImage() {
      plusMenuOpen.value = false;
      if (imageInputRef.value) {
        imageInputRef.value.value = '';
        imageInputRef.value.click();
      }
    }

    /** 文件选择后：读取图片为 dataUrl 加入待发送列表 */
    function onImageSelected(e) {
      const files = Array.from(e.target.files || []);
      for (const file of files) {
        if (!file.type.startsWith('image/')) continue;
        addImageToPending(file);
      }
    }

    /** 读取图片文件为 dataUrl 并加入待发送列表 */
    function addImageToPending(file) {
      const reader = new FileReader();
      reader.onload = () => {
        pendingImages.value.push({
          dataUrl: reader.result,
          name: file.name,
          size: file.size,
        });
      };
      reader.readAsDataURL(file);
    }

    /** 移除待发送图片 */
    function removePendingImage(index) {
      pendingImages.value.splice(index, 1);
    }

    /** 粘贴：图片走待发送列表，文本只插入纯文本（阻止 HTML 格式） */
    function onPaste(e) {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (file) {
            addImageToPending(file);
            e.preventDefault();
            return;
          }
        }
      }
      // 纯文本粘贴：阻止 HTML 格式，只插入文本
      const text = e.clipboardData?.getData('text/plain') || '';
      if (text) {
        e.preventDefault();
        document.execCommand('insertText', false, text);
      }
    }

    /** 拖拽图片到输入框 */
    function onDrop(e) {
      const files = e.dataTransfer?.files;
      if (!files || files.length === 0) return;
      for (const file of Array.from(files)) {
        if (file.type.startsWith('image/')) {
          addImageToPending(file);
        }
      }
    }

    /** 批量发送待发送图片 */
    async function doSendImages() {
      if (pendingImages.value.length === 0 || sending.value || !selectedCid.value) return;
      sending.value = true;
      const images = [...pendingImages.value];
      let successCount = 0;
      let failCount = 0;
      try {
        for (const img of images) {
          try {
            const data = await api('/api/messages/image', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                cid: selectedCid.value,
                image: img.dataUrl,
                account: currentAccount.value || undefined,
              }),
            });
            // 追加到消息列表
            messages.value.push({
              msgId: data.msgId,
              category: 'image',
              text: '[图片]',
              stickerUrl: img.dataUrl,
              isSelf: true,
              timestamp: Date.now(),
            });
            successCount++;
          } catch (e) {
            failCount++;
            console.error('图片发送失败:', e);
          }
        }
        await nextTick();
        scrollToBottom();
        // 更新会话列表排序
        const idx = contacts.value.findIndex((c) => c.conversationId === selectedCid.value);
        if (idx >= 0) {
          const c = contacts.value[idx];
          c.lastMessage = '[图片]';
          c.lastMessageTs = Date.now();
          sortContactsInPlace();
        }
        if (failCount === 0) {
          showToast(`成功发送 ${successCount} 张图片`, 'success');
          pendingImages.value = [];
        } else {
          showToast(`成功 ${successCount} 张，失败 ${failCount} 张`, 'error');
        }
      } finally {
        sending.value = false;
      }
    }

    /** 触发通用文件选择器 */
    function pickFile() {
      plusMenuOpen.value = false;
      if (fileInputRef.value) {
        fileInputRef.value.value = '';
        fileInputRef.value.click();
      }
    }

    /** 通用文件选择回调（暂未实现非图片文件发送） */
    function onFilePicked(e) {
      const files = Array.from(e.target.files || []);
      if (files.length === 0) return;
      // 非图片文件：抖音 IM 暂不支持直接发送，提示用户
      const imageFiles = files.filter((f) => f.type.startsWith('image/'));
      if (imageFiles.length > 0) {
        for (const f of imageFiles) addImageToPending(f);
      }
      const otherFiles = files.filter((f) => !f.type.startsWith('image/'));
      if (otherFiles.length > 0) {
        showToast('暂不支持发送非图片文件', 'error');
      }
    }

    function scrollToBottom() {
      if (msgListRef.value) {
        msgListRef.value.scrollTop = msgListRef.value.scrollHeight;
      }
    }

    /* ----------------------------- 未读数轮询 ----------------------------- */
    /** 轮询定时器 ID */
    let contactsPollTimer = null;
    /** 轮询间隔（毫秒） */
    const POLL_INTERVAL = 15000;

    /** 静默刷新联系人列表（不显示 loading，不显示错误） */
    async function pollContacts() {
      if (!currentAccount.value) return;
      try {
        const data = await api('/api/contacts');
        if (data.contacts) {
          contacts.value = data.contacts;
        }
      } catch {
        // 静默忽略错误
      }
    }

    function startPolling() {
      stopPolling();
      contactsPollTimer = setInterval(pollContacts, POLL_INTERVAL);
    }

    function stopPolling() {
      if (contactsPollTimer) {
        clearInterval(contactsPollTimer);
        contactsPollTimer = null;
      }
    }

    /** 页面可见性变化：隐藏时暂停轮询，可见时立即刷新并恢复轮询 */
    function onVisibilityChange() {
      if (document.hidden) {
        stopPolling();
      } else {
        pollContacts();
        startPolling();
      }
    }

    onMounted(async () => {
      loadEmojiMap();
      await loadAccounts();
      if (currentAccount.value) {
        await loadContacts();
      } else {
        // 没有账号，自动打开账号菜单提示登录
        showAccountMenu.value = true;
      }
      // 启动未读数轮询
      startPolling();
      document.addEventListener('visibilitychange', onVisibilityChange);

      // 移除全局加载遮罩
      const el = document.getElementById('app-loading');
      if (el) {
        el.classList.add('hide');
        setTimeout(() => el.remove(), 300);
      }
    });

    onUnmounted(() => {
      stopPolling();
      document.removeEventListener('visibilitychange', onVisibilityChange);
    });

    return {
      // 状态
      nav,
      accounts,
      currentAccount,
      showAccountMenu,
      contacts,
      contactsError,
      loadingContacts,
      searchKeyword,
      selectedCid,
      selectedContact,
      messages,
      messagesError,
      loadingMessages,
      msgListRef,
      hasMoreMessages,
      loadingMoreMessages,
      previewImageUrl,
      toast,
      myProfile,
      loginDialog,
      scanDialog,
      draftText,
      sending,
      emojiMap,
      emojiMapLoaded,
      emojiPanelOpen,
      plusMenuOpen,
      pendingImages,
      messageInputRef,
      imageInputRef,
      fileInputRef,
      // 计算属性
      totalUnread,
      filteredContacts,
      // 方法
      formatTime,
      formatShortTime,
      formatFullTime,
      formatMsgTime,
      shouldShowTimeDivider,
      msgRowClass,
      msgBubbleClass,
      msgAvatarClass,
      msgAvatarText,
      msgTagText,
      msgTagClass,
      previewImage,
      loadImageWithFullParams,
      renderEmoji,
      loadAccounts,
      switchAccount,
      deleteAccount,
      openLoginDialog,
      closeLoginDialog,
      doQrLogin,
      doCookieLogin,
      scanBrowser,
      closeScanDialog,
      toggleScanSelect,
      doImportScanned,
      loadContacts,
      selectContact,
      reloadMessages,
      loadMoreMessages,
      onMessagesScroll,
      doSendMessage,
      // 表情与图片
      toggleEmojiPanel,
      openEmojiFromPlus,
      insertEmoji,
      onDraftInput,
      pickImage,
      onImageSelected,
      removePendingImage,
      onPaste,
      onDrop,
      doSendImages,
      pickFile,
      onFilePicked,
    };
  },
}).mount('#app');
