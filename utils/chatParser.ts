
import { DB } from './db';
import { LocalNotifications } from '@capacitor/local-notifications';

export const ChatParser = {
    // Return cleaned content and perform side effects
    parseAndExecuteActions: async (
        aiContent: string, 
        charId: string, 
        charName: string, 
        addToast: (msg: string, type: 'info'|'success'|'error') => void
    ) => {
        let content = aiContent;

        // POKE
        if (content.includes('[[ACTION:POKE]]')) {
            await DB.saveMessage({ charId, role: 'assistant', type: 'interaction', content: '[戳一戳]' });
            content = content.replace('[[ACTION:POKE]]', '').trim();
        }
        
        // TRANSFER
        const transferMatch = content.match(/\[\[ACTION:TRANSFER:(\d+)\]\]/);
        if (transferMatch) {
            await DB.saveMessage({ charId, role: 'assistant', type: 'transfer', content: '[转账]', metadata: { amount: transferMatch[1] } });
            content = content.replace(transferMatch[0], '').trim();
        }

        // ADD_EVENT
        const eventMatch = content.match(/\[\[ACTION:ADD_EVENT\s*\|\s*(.*?)\s*\|\s*(.*?)\]\]/);
        if (eventMatch) {
            const title = eventMatch[1].trim();
            const date = eventMatch[2].trim();
            if (title && date) {
                const anni: any = { id: `anni-${Date.now()}`, title: title, date: date, charId };
                await DB.saveAnniversary(anni);
                addToast(`${charName} 添加了新日程: ${title}`, 'success');
                await DB.saveMessage({ charId, role: 'system', type: 'text', content: `[系统: ${charName} 新增了日程 "${title}" (${date})]` });
            }
            content = content.replace(eventMatch[0], '').trim();
        }

        // SCHEDULE
        const scheduleRegex = /\[schedule_message \| (.*?) \| fixed \| (.*?)\]/g;
        let match;
        while ((match = scheduleRegex.exec(content)) !== null) {
            const timeStr = match[1].trim();
            const msgContent = match[2].trim();
            const dueTime = new Date(timeStr).getTime();
            if (!isNaN(dueTime) && dueTime > Date.now()) {
                await DB.saveScheduledMessage({ id: `sched-${Date.now()}-${Math.random()}`, charId, content: msgContent, dueAt: dueTime, createdAt: Date.now() });
                try {
                    const hasPerm = await LocalNotifications.checkPermissions();
                    if (hasPerm.display === 'granted') {
                        await LocalNotifications.schedule({ notifications: [{ title: charName, body: msgContent, id: Math.floor(Math.random() * 100000), schedule: { at: new Date(dueTime) }, smallIcon: 'ic_stat_icon_config_sample' }] });
                    }
                } catch (e) { console.log("Notification schedule skipped (web mode)"); }
                addToast(`${charName} 似乎打算一会儿找你...`, 'info');
            }
        }
        content = content.replace(scheduleRegex, '').trim();

        // RECALL tag removal (handling done in main loop logic, but cleaning here just in case)
        content = content.replace(/\[\[RECALL:.*?\]\]/g, '').trim();

        return content;
    },

    // Split text into bubbles (text and emojis)
    splitResponse: (content: string): { type: 'text' | 'emoji', content: string }[] => {
        const emojiPattern = /\[\[SEND_EMOJI:\s*(.*?)\]\]/g;
        const parts: {type: 'text' | 'emoji', content: string}[] = [];
        let lastIndex = 0;
        let emojiMatch;
        
        while ((emojiMatch = emojiPattern.exec(content)) !== null) {
            if (emojiMatch.index > lastIndex) {
                const textBefore = content.slice(lastIndex, emojiMatch.index).trim();
                if (textBefore) parts.push({ type: 'text', content: textBefore });
            }
            parts.push({ type: 'emoji', content: emojiMatch[1].trim() });
            lastIndex = emojiMatch.index + emojiMatch[0].length;
        }
        
        if (lastIndex < content.length) {
            const remaining = content.slice(lastIndex).trim();
            if (remaining) parts.push({ type: 'text', content: remaining });
        }
        
        if (parts.length === 0 && content.trim()) parts.push({ type: 'text', content: content.trim() });
        return parts;
    },

    // Chunking text for typing effect
    chunkText: (text: string): string[] => {
        // 1. Protect [[QUOTE:...]] tags from being split by punctuation inside them
        const quoteMap: Record<string, string> = {};
        let quoteIdx = 0;
        let tempContent = text.replace(/\[\[QUOTE:\s*[\s\S]*?\]\]/g, (match) => {
            const key = `{{QUOTE_${quoteIdx++}}}`;
            quoteMap[key] = match;
            return key;
        });

        tempContent = tempContent
            .replace(/\.\.\./g, '{{ELLIPSIS_ENG}}')
            .replace(/……/g, '{{ELLIPSIS_CN}}')
            .replace(/([。])(?![）\)\]】""'])/g, '{{SPLIT}}')
            // Only split on English period at true end-of-sentence:
            // Must be followed by end-of-string, newline, or whitespace+uppercase/space
            // NOT followed by opening paren, Chinese chars, or lowercase continuation
            .replace(/\.(?=\s*$)/gm, '{{SPLIT}}')
            .replace(/\.(?=\s+[A-Z])/g, '.{{SPLIT}}')
            .replace(/([！!？?~]+)(?![）\)\]】""'])/g, '$1{{SPLIT}}')
            .replace(/\n+/g, '{{SPLIT}}')
            .replace(/([\u4e00-\u9fa5])[ ]+([\u4e00-\u9fa5])/g, '$1{{SPLIT}}$2');

        const chunks = tempContent.split('{{SPLIT}}')
            .map(c => c.trim())
            .filter(c => c.length > 0)
            .map(c => {
                c = c.replace(/{{ELLIPSIS_ENG}}/g, '...').replace(/{{ELLIPSIS_CN}}/g, '……');
                // Restore QUOTE placeholders
                Object.keys(quoteMap).forEach(key => {
                    c = c.replace(key, quoteMap[key]);
                });
                return c;
            });

        return chunks;
    }
}
