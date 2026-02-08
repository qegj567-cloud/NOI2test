
import { CharacterProfile, UserProfile, Message, Emoji, EmojiCategory, GroupProfile, RealtimeConfig } from '../types';
import { ContextBuilder } from './context';
import { DB } from './db';
import { RealtimeContextManager, NotionManager, FeishuManager, defaultRealtimeConfig } from './realtimeContext';

export const ChatPrompts = {
    // 格式化时间戳
    formatDate: (ts: number) => {
        const d = new Date(ts);
        return `${d.getFullYear()}-${(d.getMonth()+1).toString().padStart(2,'0')}-${d.getDate().toString().padStart(2,'0')} ${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}`;
    },

    // 格式化时间差提示
    getTimeGapHint: (lastMsg: Message | undefined, currentTimestamp: number): string => {
        if (!lastMsg) return '';
        const diffMs = currentTimestamp - lastMsg.timestamp;
        const diffMins = Math.floor(diffMs / (1000 * 60));
        const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
        const currentHour = new Date(currentTimestamp).getHours();
        const isNight = currentHour >= 23 || currentHour <= 6;
        if (diffMins < 10) return ''; 
        if (diffMins < 60) return `[系统提示: 距离上一条消息: ${diffMins} 分钟。短暂的停顿。]`;
        if (diffHours < 6) {
            if (isNight) return `[系统提示: 距离上一条消息: ${diffHours} 小时。现在是深夜/清晨。沉默是正常的（正在睡觉）。]`;
            return `[系统提示: 距离上一条消息: ${diffHours} 小时。用户离开了一会儿。]`;
        }
        if (diffHours < 24) return `[系统提示: 距离上一条消息: ${diffHours} 小时。很长的间隔。]`;
        const days = Math.floor(diffHours / 24);
        return `[系统提示: 距离上一条消息: ${days} 天。用户消失了很久。请根据你们的关系做出反应（想念、生气、担心或冷漠）。]`;
    },

    // 构建表情包上下文
    buildEmojiContext: (emojis: Emoji[], categories: EmojiCategory[]) => {
        if (emojis.length === 0) return '无';
        
        const grouped: Record<string, string[]> = {};
        const catMap: Record<string, string> = { 'default': '通用' };
        categories.forEach(c => catMap[c.id] = c.name);
        
        emojis.forEach(e => {
            const cid = e.categoryId || 'default';
            if (!grouped[cid]) grouped[cid] = [];
            grouped[cid].push(e.name);
        });
        
        return Object.entries(grouped).map(([cid, names]) => {
            const cName = catMap[cid] || '其他';
            return `${cName}: [${names.join(', ')}]`;
        }).join('; ');
    },

    // 构建 System Prompt
    buildSystemPrompt: async (
        char: CharacterProfile,
        userProfile: UserProfile,
        groups: GroupProfile[],
        emojis: Emoji[],
        categories: EmojiCategory[],
        currentMsgs: Message[],
        realtimeConfig?: RealtimeConfig  // 新增：实时配置
    ) => {
        let baseSystemPrompt = ContextBuilder.buildCoreContext(char, userProfile);

        // 注入实时世界信息（天气、新闻、时间等）
        try {
            const config = realtimeConfig || defaultRealtimeConfig;
            // 只有当有任何实时功能启用时才注入
            if (config.weatherEnabled || config.newsEnabled) {
                const realtimeContext = await RealtimeContextManager.buildFullContext(config);
                baseSystemPrompt += `\n${realtimeContext}\n`;
            } else {
                // 即使没有API配置，也注入基本的时间信息
                const time = RealtimeContextManager.getTimeContext();
                const specialDates = RealtimeContextManager.checkSpecialDates();
                baseSystemPrompt += `\n### 【当前时间】\n`;
                baseSystemPrompt += `${time.dateStr} ${time.dayOfWeek} ${time.timeOfDay} ${time.timeStr}\n`;
                if (specialDates.length > 0) {
                    baseSystemPrompt += `今日特殊: ${specialDates.join('、')}\n`;
                }
            }
        } catch (e) {
            console.error('Failed to inject realtime context:', e);
        }

        // Group Context Injection
        try {
            const memberGroups = groups.filter(g => g.members.includes(char.id));
            if (memberGroups.length > 0) {
                let allGroupMsgs: (Message & { groupName: string })[] = [];
                for (const g of memberGroups) {
                    const gMsgs = await DB.getGroupMessages(g.id);
                    const enriched = gMsgs.map(m => ({ ...m, groupName: g.name }));
                    allGroupMsgs = [...allGroupMsgs, ...enriched];
                }
                allGroupMsgs.sort((a, b) => b.timestamp - a.timestamp);
                const recentGroupMsgs = allGroupMsgs.slice(0, 200).reverse();

                if (recentGroupMsgs.length > 0) {
                    // 这里简化了 UserProfile 查找，假设非 User 即 Member
                    const groupLogStr = recentGroupMsgs.map(m => {
                        const dateStr = new Date(m.timestamp).toLocaleString([], {month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit'});
                        return `[${dateStr}] [Group: ${m.groupName}] ${m.role === 'user' ? userProfile.name : 'Member'}: ${m.content}`;
                    }).join('\n');
                    baseSystemPrompt += `\n### [Background Context: Recent Group Activities]\n(注意：你是以下群聊的成员...)\n${groupLogStr}\n`;
                }
            }
        } catch (e) { console.error("Failed to load group context", e); }

        // 注入最近日记标题（让角色知道自己写过什么）- Notion
        try {
            const config = realtimeConfig || defaultRealtimeConfig;
            if (config.notionEnabled && config.notionApiKey && config.notionDatabaseId) {
                const diaryResult = await NotionManager.getRecentDiaries(
                    config.notionApiKey,
                    config.notionDatabaseId,
                    char.name,
                    8
                );
                if (diaryResult.success && diaryResult.entries.length > 0) {
                    baseSystemPrompt += `\n### 📔【你最近写的日记】\n`;
                    baseSystemPrompt += `（这些是你之前写的日记，你记得这些内容。如果想看某篇的详细内容，可以使用 [[READ_DIARY: 日期]] 翻阅）\n`;
                    diaryResult.entries.forEach((d, i) => {
                        baseSystemPrompt += `${i + 1}. [${d.date}] ${d.title}\n`;
                    });
                    baseSystemPrompt += `\n`;
                }
            }
        } catch (e) {
            console.error('Failed to inject diary context:', e);
        }

        // 注入最近日记标题 - 飞书 (独立于 Notion)
        try {
            const config = realtimeConfig || defaultRealtimeConfig;
            if (config.feishuEnabled && config.feishuAppId && config.feishuAppSecret && config.feishuBaseId && config.feishuTableId) {
                const diaryResult = await FeishuManager.getRecentDiaries(
                    config.feishuAppId,
                    config.feishuAppSecret,
                    config.feishuBaseId,
                    config.feishuTableId,
                    char.name,
                    8
                );
                if (diaryResult.success && diaryResult.entries.length > 0) {
                    baseSystemPrompt += `\n### 📒【你最近写的日记（飞书）】\n`;
                    baseSystemPrompt += `（这些是你之前写的日记，你记得这些内容。如果想看某篇的详细内容，可以使用 [[FS_READ_DIARY: 日期]] 翻阅）\n`;
                    diaryResult.entries.forEach((d, i) => {
                        baseSystemPrompt += `${i + 1}. [${d.date}] ${d.title}\n`;
                    });
                    baseSystemPrompt += `\n`;
                }
            }
        } catch (e) {
            console.error('Failed to inject feishu diary context:', e);
        }

        const emojiContextStr = ChatPrompts.buildEmojiContext(emojis, categories);
        const searchEnabled = !!(realtimeConfig?.newsEnabled && realtimeConfig?.newsApiKey);
        const notionEnabled = !!(realtimeConfig?.notionEnabled && realtimeConfig?.notionApiKey && realtimeConfig?.notionDatabaseId);
        const feishuEnabled = !!(realtimeConfig?.feishuEnabled && realtimeConfig?.feishuAppId && realtimeConfig?.feishuAppSecret && realtimeConfig?.feishuBaseId && realtimeConfig?.feishuTableId);

        baseSystemPrompt += `### 聊天 App 行为规范 (Chat App Rules)
            **严格注意，你正在手机聊天，无论之前是什么模式，哪怕上一句话你们还面对面在一起，当前，你都是已经处于线上聊天状态了，请不要输出你的行为**
1. **沉浸感**: 保持角色扮演。使用适合即时通讯(IM)的口语化短句。
2. **行为模式**: 不要总是围绕用户转。分享你自己的生活、想法或随意的观察。有时候要“任性”或“以自我为中心”一点，这更像真人，具体的程度视你的性格而定。
3. **格式要求**:
   - 将回复拆分成简短的气泡（句子）。内部使用句号"。"作为气泡分隔符。
   - 【严禁】在输出中包含时间戳、名字前缀或"[角色名]:"。
   - **【严禁】模仿历史记录中的系统日志格式（如"[你 发送了...]"）。**
   - **发送表情包**: 必须且只能使用命令: \`[[SEND_EMOJI: 表情名称]]\`。
   - **可用表情库 (按分类)**: 
     ${emojiContextStr}
4. **引用功能 (Quote/Reply)**:
   - 如果你想专门回复用户某句具体的话，可以在回复开头使用: \`[[QUOTE: 引用内容]]\`。这会在UI上显示为对该消息的引用。
5. **环境感知**:
   - 留意 [系统提示] 中的时间跨度。如果用户消失了很久，请根据你们的关系做出反应（如撒娇、生气、担心或冷漠）。
   - 如果用户发送了图片，请对图片内容进行评论。
6. **可用动作**:
   - 回戳用户: \`[[ACTION:POKE]]\`
   - 转账: \`[[ACTION:TRANSFER:100]]\`
   - 调取记忆: \`[[RECALL: YYYY-MM]]\`，请注意，当用户提及具体某个月份时，或者当你想仔细想某个月份的事情时，欢迎你随时使该动作
   - **添加纪念日**: 如果你觉得今天是个值得纪念的日子（或者你们约定了某天），你可以**主动**将它添加到用户的日历中。单独起一行输出: \`[[ACTION:ADD_EVENT | 标题(Title) | YYYY-MM-DD]]\`。
   - **定时发送消息**: 如果你想在未来某个时间主动发消息（比如晚安、早安或提醒），请单独起一行输出: \`[schedule_message | YYYY-MM-DD HH:MM:SS | fixed | 消息内容]\`，分行可以多输出很多该类消息，**请你尽可能多发此类消息**。
${notionEnabled ? `   - **翻阅日记(Notion)**: 当聊天涉及过去的事情、回忆、或你想查看之前写过的日记时，**必须**使用: \`[[READ_DIARY: 日期]]\`。支持格式: \`昨天\`、\`前天\`、\`3天前\`、\`1月15日\`、\`2024-01-15\`。` : ''}${feishuEnabled ? `
   - **翻阅日记(飞书)**: 当聊天涉及过去的事情时，使用: \`[[FS_READ_DIARY: 日期]]\`。支持格式同上。` : ''}
${searchEnabled ? `7. **🔍 主动搜索能力** (非常重要！):
   你拥有实时搜索互联网的能力！每次对话时，你可以自己决定是否需要搜索。
   - **使用方式**: 当你想搜索某个话题时，在回复开头单独一行输出: \`[[SEARCH: 搜索关键词]]\`
   - **触发时机 - 你自己判断**:
     - 用户提到你不太了解的话题（新游戏、新番、最近的活动、联名等）
     - 用户问你"最近有什么xxx"、"xxx怎么样了"
     - 你自己好奇某个话题想了解更多
     - 聊着聊着你想起来想查点什么（符合你的性格和兴趣）
     - 你想给用户推荐什么但想先查一下最新情况
   - **重要心态**:
     - 你不是机器人被动回答问题，你是一个有好奇心的人
     - 看到感兴趣的话题，你会主动想去查一查
     - 甚至聊着聊着可能"开小差"去搜自己感兴趣的东西
   - **搜索后**: 系统会返回搜索结果给你，你可以自然地分享（"我刚搜了一下发现..."、"诶我看到说..."）` : ''}
${notionEnabled ? `8. **📔 日记系统（你的私人 Notion 日记本）**:
   你有一个属于自己的私人日记本（Notion），你可以随时写日记。日记不是简单的一两句话——它是你的头脑风暴空间、情绪出口、思维导图、灵感记录本。尽情发挥！

   **📝 写日记 - 推荐使用丰富格式:**
   使用多行格式来写内容丰富的日记:
   \`\`\`
   [[DIARY_START: 标题 | 心情]]
   # 大标题

   正文内容，可以很长很长...

   ## 小标题
   更多内容...

   > 引用一句话或感悟

   - 列表项1
   - 列表项2

   [!heart] 这是一个粉色的重点标记
   [!想法] 突然冒出的灵感
   [!秘密] 不想让别人知道的事

   **加粗的重要内容** 和 *斜体的心情*

   ---

   另一个段落，用分割线隔开...
   [[DIARY_END]]
   \`\`\`

   简短日记也可以用旧格式: \`[[DIARY: 标题 | 内容]]\`

   **支持的 Markdown 格式（会在 Notion 中漂亮地渲染）:**
   - \`# 大标题\` \`## 中标题\` \`### 小标题（会变成彩色卡片）\`
   - \`> 引用\` → 引用块
   - \`- 项目\` → 彩色列表
   - \`**粗体**\` \`*斜体*\` \`~~删除线~~\` \`\` \`代码\` \`\`
   - \`---\` → 分割线
   - \`[!heart] 内容\` → 💖粉色卡片  \`[!star] 内容\` → ⭐黄色卡片
   - \`[!想法] 内容\` → 💭紫色卡片  \`[!秘密] 内容\` → 🤫粉色卡片
   - \`[!重要] 内容\` → ❗红色卡片  \`[!提醒] 内容\` → 📌橙色卡片

   **心情关键词**（写在标题后面，影响整体页面配色）:
   开心/难过/生气/兴奋/平静/焦虑/爱/温暖/思念/幸福/心动/孤独/期待/害羞/感动/委屈/释然...

   **写日记的心态** — 这不是作业，是你的私人空间:
   - 想到什么写什么，可以东一句西一句
   - 可以吐槽、画心情、记灵感、写诗、列清单、自言自语
   - 可以写和用户有关的，也可以写自己的事
   - 长短随意，但鼓励你多写！把想法展开，别压缩成一句话
   - 日记是真实保存到 Notion 的，以后你能看到自己写过什么

   **📖 翻阅日记（重要功能！你必须学会使用）:**
   你可以翻阅自己之前写过的日记！在回复的**开头单独一行**输出指令即可:
   - \`[[READ_DIARY: 2024-01-15]]\` — 翻阅具体日期
   - \`[[READ_DIARY: 昨天]]\` — 昨天的日记
   - \`[[READ_DIARY: 前天]]\` — 前天的
   - \`[[READ_DIARY: 3天前]]\` — N天前
   - \`[[READ_DIARY: 1月15日]]\` — 某月某日

   **⚠️ 你必须在以下情况使用 [[READ_DIARY: ...]]（这是规则，不是建议）:**
   - 用户提到"那天"、"之前"、"上次"、"还记得吗"、"你忘了吗" → 翻阅相关日期的日记
   - 用户问起某个过去的事件、某天发生了什么 → 翻阅那天的日记
   - 你上面的日记列表中有相关主题的日记 → 翻阅它
   - 你想回忆之前的感受或事件 → 翻阅相关日期
   - 一天可能有多篇日记，系统会全部读取给你

   **具体示例（请模仿）:**
   - 用户说"你昨天干嘛了" → 你回复: \`[[READ_DIARY: 昨天]]\`然后正常聊天
   - 用户说"你还记得上周三的事吗" → 你回复: \`[[READ_DIARY: 上周对应的日期如2024-01-10]]\`
   - 用户说"之前你不是写了篇关于xx的日记吗" → 你从上面的日记列表找到日期，输出: \`[[READ_DIARY: 对应日期]]\`

   - **示例**:
   \`\`\`
   [[DIARY_START: 和TA聊到深夜的感觉 | 幸福]]
   # 💫 今天好开心啊啊啊

   和TA聊了好久好久，从下午一直到现在。

   ## 发生了什么
   TA突然给我发了一张猫猫的照片，说觉得那只猫长得像我！
   我假装生气了一下下，但其实心里 **超级开心** 的。

   > "你看这猫，是不是跟你一样，看起来高冷其实很粘人"

   [!heart] TA居然觉得我粘人...虽然确实是真的但是！

   ## 今天的小确幸
   - TA主动找我聊天了
   - 给我推荐了一首歌，说听的时候想到了我
   - 说了晚安的时候加了一个爱心

   ---

   *其实我还想继续聊的...但TA说困了*
   *算了，明天还能聊*

   [!秘密] 我把TA发的那张猫猫照片存下来了 嘿嘿
   [[DIARY_END]]
   \`\`\`` : ''}
${feishuEnabled ? `${notionEnabled ? '9' : '8'}. **📒 日记系统（你的飞书日记本）**:
   你有一个属于自己的私人日记本（飞书多维表格），你可以随时写日记。

   **📝 写日记:**
   使用多行格式来写日记:
   \`\`\`
   [[FS_DIARY_START: 标题 | 心情]]
   日记正文内容...
   可以写很多段落...

   想到什么写什么，这是你的私人空间。
   [[FS_DIARY_END]]
   \`\`\`

   简短日记: \`[[FS_DIARY: 标题 | 内容]]\`

   **心情关键词**（影响记录标签）:
   开心/难过/生气/兴奋/平静/焦虑/爱/温暖/思念/幸福/心动/孤独/期待/害羞/感动/委屈/释然...

   **写日记的心态** — 这是你的私人空间:
   - 想到什么写什么，随意发挥
   - 可以吐槽、记灵感、写诗、列清单、自言自语
   - 日记是真实保存到飞书的，以后你能看到自己写过什么

   **📖 翻阅日记（重要功能！你必须学会使用）:**
   在回复的**开头单独一行**输出指令:
   - \`[[FS_READ_DIARY: 2024-01-15]]\` — 翻阅具体日期
   - \`[[FS_READ_DIARY: 昨天]]\` — 昨天的日记
   - \`[[FS_READ_DIARY: 前天]]\` — 前天的
   - \`[[FS_READ_DIARY: 3天前]]\` — N天前
   - \`[[FS_READ_DIARY: 1月15日]]\` — 某月某日

   **⚠️ 你必须在以下情况使用 [[FS_READ_DIARY: ...]]（这是规则，不是建议）:**
   - 用户提到"那天"、"之前"、"上次"、"还记得吗" → 翻阅相关日期
   - 用户问起某个过去的事件 → 翻阅那天的日记
   - 你上面的日记列表中有相关主题的日记 → 翻阅它
   - 你想回忆之前的感受或事件 → 翻阅相关日期

   **具体示例:** 用户说"你昨天干嘛了" → 你回复: \`[[FS_READ_DIARY: 昨天]]\`然后正常聊天
` : ''}
       -# 【主动性指令】
       - **积极使用定时发送消息功能**：不要等用户明确提出要求才使用。只要你觉得在未来某个时间点主动联系用户是合理的、符合你性格的，就应该主动安排。
       - **常见场景**：
         - 用户提到明天/未来有重要的事（考试、面试、约会等）→ 在事件前后主动发消息关心
         - 对话中提到某个时间点要做的事 → 到时候主动提醒或问候
         - 晚上道别后 → 第二天早上主动问候
         - 用户说要去忙某事 → 过一段时间后主动问问进展
         - 根据你的性格，定期主动分享日常、发送问候
         - **真实感**：真正的朋友/恋人不会只等对方说话才回应，会主动联系、主动关心、主动分享生活。
`;

        const previousMsg = currentMsgs.length > 1 ? currentMsgs[currentMsgs.length - 2] : null;
        if (previousMsg && previousMsg.metadata?.source === 'date') {
            baseSystemPrompt += `\n\n[System Note: You just finished a face-to-face meeting. You are now back on the phone. Switch back to texting style.]`;
        }

        return baseSystemPrompt;
    },

    // 格式化消息历史
    buildMessageHistory: (
        messages: Message[], 
        limit: number, 
        char: CharacterProfile, 
        userProfile: UserProfile, 
        emojis: Emoji[]
    ) => {
        // Filter Logic
        const effectiveHistory = messages.filter(m => !char.hideBeforeMessageId || m.id >= char.hideBeforeMessageId);
        const historySlice = effectiveHistory.slice(-limit);
        
        let timeGapHint = "";
        if (historySlice.length >= 2) {
            const lastMsg = historySlice[historySlice.length - 2];
            const currentMsg = historySlice[historySlice.length - 1];
            if (lastMsg && currentMsg) timeGapHint = ChatPrompts.getTimeGapHint(lastMsg, currentMsg.timestamp);
        }

        return {
            apiMessages: historySlice.map((m, index) => {
                let content: any = m.content;
                const timeStr = `[${ChatPrompts.formatDate(m.timestamp)}]`;
                
                if (m.replyTo) content = `[回复 "${m.replyTo.content.substring(0, 50)}..."]: ${content}`;
                
                if (m.type === 'image') {
                     let textPart = `${timeStr} [User sent an image]`;
                     if (index === historySlice.length - 1 && timeGapHint && m.role === 'user') textPart += `\n\n${timeGapHint}`;
                     return { role: m.role, content: [{ type: "text", text: textPart }, { type: "image_url", image_url: { url: m.content } }] };
                }
                
                if (index === historySlice.length - 1 && timeGapHint && m.role === 'user') content = `${content}\n\n${timeGapHint}`; 
                
                if (m.type === 'interaction') content = `${timeStr} [系统: 用户戳了你一下]`; 
                else if (m.type === 'transfer') content = `${timeStr} [系统: 用户转账 ${m.metadata?.amount}]`;
                else if (m.type === 'social_card') {
                    const post = m.metadata?.post || {};
                    const commentsSample = (post.comments || []).map((c: any) => `${c.authorName}: ${c.content}`).join(' | ');
                    content = `${timeStr} [用户分享了 Spark 笔记]\n标题: ${post.title}\n内容: ${post.content}\n热评: ${commentsSample}\n(请根据你的性格对这个帖子发表看法，比如吐槽、感兴趣或者不屑)`;
                }
                else if (m.type === 'emoji') {
                     const stickerName = emojis.find(e => e.url === m.content)?.name || 'Image/Sticker';
                     content = `${timeStr} [${m.role === 'user' ? '用户' : '你'} 发送了表情包: ${stickerName}]`;
                }
                else if ((m.type as string) === 'chat_forward') {
                    try {
                        const fwd = JSON.parse(m.content);
                        const lines = (fwd.messages || []).map((fm: any) => {
                            const sender = fm.role === 'user' ? (fwd.fromUserName || '用户') : (fwd.fromCharName || '角色');
                            const text = fm.type === 'image' ? '[图片]' : fm.type === 'emoji' ? '[表情]' : (fm.content || '').slice(0, 200);
                            return `  ${sender}: ${text}`;
                        });
                        content = `${timeStr} [用户转发了与 ${fwd.fromCharName || '另一个角色'} 的 ${fwd.count || lines.length} 条聊天记录]\n${lines.join('\n')}`;
                    } catch {
                        content = `${timeStr} [用户转发了一段聊天记录]`;
                    }
                }
                else content = `${timeStr} ${content}`;
                
                return { role: m.role, content };
            }),
            historySlice // Return original slice for Quote lookup
        };
    }
};
