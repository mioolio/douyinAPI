// 深入探查 createMessageBuilder 参数和 getAllConversation 返回
(async () => {
  const out = {};

  const vmokIm = window['__VMOK_@pc-im/im:1.0.0.696__'];
  const loaderFn = await vmokIm.get('.');
  const mod = await loaderFn();
  const ctx = mod.Context;
  const instance = ctx.instance;

  const ssm = instance.imSdkService.sendMessageManager;
  const cs = instance.store.conversationStore;
  const curConvId = cs.curConversationId;
  const curConv = cs.conversationMap.get(curConvId);

  out.curConvInfo = {
    conversationId: curConv.conversationId,
    conversationShortId: curConv.conversationShortId,
    name: curConv.name,
    targetUser: curConv.targetUser ? {
      uid: curConv.targetUser.uid,
      nickname: curConv.targetUser.nickname,
    } : null,
  };

  // 1. 尝试多种参数创建 builder
  const attempts = [
    { name: 'conversation_only', args: [curConv] },
    { name: 'conversation_content', args: [curConv, 'test'] },
    { name: 'conversation_text_type', args: [curConv, 'test', 'text'] },
    { name: 'object_form', args: [{ conversation: curConv, content: 'test', messageType: 'text' }] },
    { name: 'object_form_v2', args: [{ conversation: curConv, text: 'test' }] },
  ];

  for (const attempt of attempts) {
    try {
      const builder = await ssm.createMessageBuilder(...attempt.args);
      if (builder) {
        out['attempt_' + attempt.name] = {
          success: true,
          keys: Object.keys(builder).slice(0, 30),
          proto: Object.getOwnPropertyNames(Object.getPrototypeOf(builder)).slice(0, 50),
        };

        // 如果成功，看方法 snippet
        const methods = {};
        for (const k of Object.getOwnPropertyNames(Object.getPrototypeOf(builder))) {
          if (typeof builder[k] === 'function') {
            methods[k] = builder[k].toString().slice(0, 200);
          }
        }
        out['attempt_' + attempt.name + '_methods'] = methods;
      } else {
        out['attempt_' + attempt.name] = { success: false, returned: 'undefined' };
      }
    } catch (e) {
      out['attempt_' + attempt.name] = { success: false, error: e.message };
    }
  }

  // 2. getAllConversation 返回的对象深入查看
  const list = await instance.imSdkService.conversationListManager.getAllConversation();
  out.allConvType = typeof list;
  out.allConvKeys = Object.keys(list).slice(0, 30);
  out.allConvOwnProps = Object.getOwnPropertyNames(list).slice(0, 30);
  // mobx observable map 的常见内部属性
  out.allConvHasSize = 'size' in list;
  out.allConvSize = list.size;
  out.allConvHasValues = typeof list.values;
  out.allConvHasEntries = typeof list.entries;
  out.allConvHasForEach = typeof list.forEach;
  // 如果是 Map
  if (list.size !== undefined && typeof list.forEach === 'function') {
    const items = [];
    list.forEach((v, k) => {
      if (items.length < 3) {
        items.push({
          key: k,
          valueKeys: v ? Object.keys(v).slice(0, 10) : null,
          name: v?.name,
          targetUser: v?.targetUser ? {
            uid: v.targetUser.uid,
            nickname: v.targetUser.nickname,
          } : null,
        });
      }
    });
    out.allConvItems = items;
  }

  // 3. 直接从 conversationStore.conversationMap 取当前会话
  out.conversationMapSize = cs.conversationMap.size;
  const convList = [];
  cs.conversationMap.forEach((v, k) => {
    if (convList.length < 5) {
      convList.push({
        key: k,
        conversationId: v.conversationId,
        name: v.name,
        targetUser: v.targetUser ? {
          uid: v.targetUser.uid,
          nickname: v.targetUser.nickname,
        } : null,
      });
    }
  });
  out.conversationMapItems = convList;

  return out;
})()
