// 先点击会话列表第一项，再探查 builder
(async () => {
  const out = {};

  const vmokIm = window['__VMOK_@pc-im/im:1.0.0.696__'];
  const loaderFn = await vmokIm.get('.');
  const mod = await loaderFn();
  const ctx = mod.Context;
  const instance = ctx.instance;

  const ssm = instance.imSdkService.sendMessageManager;
  const cs = instance.store.conversationStore;

  // 1. 看 conversationMap 状态
  out.conversationMapSize = cs.conversationMap.size;
  out.curConversationId = cs.curConversationId;

  // 2. 取第一个会话作为目标
  let targetConv = null;
  let targetKey = null;
  cs.conversationMap.forEach((v, k) => {
    if (!targetConv) {
      targetConv = v;
      targetKey = k;
    }
  });

  if (!targetConv) {
    out.error = 'conversationMap is empty';
    return out;
  }

  out.targetConvInfo = {
    key: targetKey,
    conversationId: targetConv.conversationId,
    conversationShortId: targetConv.conversationShortId,
    name: targetConv.name,
    targetUser: targetConv.targetUser ? {
      uid: targetConv.targetUser.uid,
      nickname: targetConv.targetUser.nickname,
    } : null,
  };

  // 3. 尝试多种参数创建 builder
  const attempts = [
    { name: 'conversation_only', args: [targetConv] },
    { name: 'conversation_content', args: [targetConv, 'test'] },
    { name: 'conversation_text_type', args: [targetConv, 'test', 'text'] },
    { name: 'object_form', args: [{ conversation: targetConv, content: 'test', messageType: 'text' }] },
    { name: 'object_form_v2', args: [{ conversation: targetConv, text: 'test' }] },
    { name: 'object_form_v3', args: [{ conversation: targetConv, messageType: 'text', text: 'test' }] },
    { name: 'object_form_v4', args: [{ conversation: targetConv, type: 'text', text: 'test' }] },
  ];

  for (const attempt of attempts) {
    try {
      const builder = await ssm.createMessageBuilder(...attempt.args);
      if (builder) {
        const info = {
          success: true,
          keys: Object.keys(builder).slice(0, 30),
          proto: Object.getOwnPropertyNames(Object.getPrototypeOf(builder)).slice(0, 50),
        };

        // 看方法 snippet
        const methods = {};
        const proto = Object.getPrototypeOf(builder);
        if (proto) {
          for (const k of Object.getOwnPropertyNames(proto)) {
            if (typeof builder[k] === 'function') {
              methods[k] = builder[k].toString().slice(0, 200);
            }
          }
        }
        info.methods = methods;
        out['attempt_' + attempt.name] = info;
      } else {
        out['attempt_' + attempt.name] = { success: false, returned: 'undefined' };
      }
    } catch (e) {
      out['attempt_' + attempt.name] = { success: false, error: e.message };
    }
  }

  // 4. getAllConversation 深入
  try {
    const list = await instance.imSdkService.conversationListManager.getAllConversation();
    out.allConvType = typeof list;
    out.allConvKeys = Object.keys(list).slice(0, 30);
    out.allConvHasSize = 'size' in list;
    out.allConvSize = list.size;
    if (typeof list.forEach === 'function') {
      const items = [];
      list.forEach((v, k) => {
        if (items.length < 3) {
          items.push({
            key: k,
            name: v?.name,
            targetUid: v?.targetUser?.uid,
            targetNickname: v?.targetUser?.nickname,
          });
        }
      });
      out.allConvItems = items;
    }
  } catch (e) {
    out.getAllConvError = e.message;
  }

  return out;
})()
