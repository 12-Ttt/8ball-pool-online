import React, { useState } from 'react';
import { MessageSquare, Send } from 'lucide-react';
import { QUICK_EMOTES } from '../game/constants';

interface EmoteBarProps {
  onSend: (text: string) => void;
  disabled?: boolean;
}

export const EmoteBar: React.FC<EmoteBarProps> = ({ onSend, disabled = false }) => {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = draft.trim().slice(0, 28);
    if (!trimmed) return;
    onSend(trimmed);
    setDraft('');
    setOpen(false);
  };

  return (
    <div className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-[#191d25] hover:bg-[#232834] border border-white/10 text-xs font-medium text-[#f3efe6] transition-colors cursor-pointer whitespace-nowrap disabled:opacity-45"
      >
        <MessageSquare className="w-3.5 h-3.5 text-[#d4a853]" />
        快捷互动
      </button>

      {open && (
        <div className="absolute right-0 bottom-12 z-30 w-72 p-3 rounded-xl bg-[#181c24] border border-white/12 shadow-[0_18px_48px_rgba(0,0,0,0.65)] space-y-2.5">
          <div className="grid grid-cols-2 gap-1.5">
            {QUICK_EMOTES.map((emote) => (
              <button
                key={emote}
                type="button"
                onClick={() => {
                  onSend(emote);
                  setOpen(false);
                }}
                className="px-2.5 py-2 rounded-lg bg-[#11141a] hover:bg-[#232936] text-left text-xs text-[#f3efe6] border border-white/6 transition-colors cursor-pointer whitespace-nowrap truncate"
              >
                {emote}
              </button>
            ))}
          </div>

          <form onSubmit={handleSubmit} className="flex items-center gap-1.5 pt-1 border-t border-white/8">
            <input
              type="text"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              maxLength={28}
              placeholder="输入简短消息..."
              className="flex-1 min-w-0 px-2.5 py-1.5 rounded-lg bg-[#0f1217] border border-white/10 text-xs text-[#f3efe6] placeholder:text-[#6b7280] focus:outline-none focus:border-[#d4a853]"
            />
            <button
              type="submit"
              className="p-2 rounded-lg bg-[#d4a853] hover:bg-[#e1b866] text-[#111317] transition-colors cursor-pointer shrink-0"
              aria-label="发送消息"
            >
              <Send className="w-3.5 h-3.5" />
            </button>
          </form>
        </div>
      )}
    </div>
  );
};
