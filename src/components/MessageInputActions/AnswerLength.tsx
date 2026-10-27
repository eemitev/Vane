'use client';

import { cn } from '@/lib/utils';
import { useChat } from '@/lib/hooks/useChat';
import {
  Popover,
  PopoverButton,
  PopoverPanel,
} from '@headlessui/react';
import { AnimatePresence, motion } from 'motion/react';
import {
  ChevronDown,
  FileText,
  Newspaper,
  Sparkles,
  StickyNote,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

/* Four stops rather than three: "auto" has to be reachable, because it is the
 * only setting that lets the research depth decide the answer length, and it is
 * the default.
 *
 * Icons are document sizes -- a note, a page, a report -- rather than text
 * density. Two reasons. Zap was the obvious choice for Brief and is already the
 * Speed icon on the research-depth control sitting beside this one, in the same
 * orange, so picking Brief showed two identical bolts. And at 16px the
 * density glyphs (AlignLeft against AlignJustify) differ by a couple of pixels
 * of line width, which is not a difference anyone can read; these three
 * silhouettes are distinct at that size. */
const STYLES = [
  {
    key: 'auto',
    title: 'Auto',
    description: 'Follows your research depth.',
    icon: <Sparkles size={16} className="text-[#9C27B0]" />,
  },
  {
    key: 'brief',
    title: 'Brief',
    description: 'A few sentences, no headings.',
    icon: <StickyNote size={16} className="text-[#FF9800]" />,
  },
  {
    key: 'standard',
    title: 'Standard',
    description: 'Short answer, a few points.',
    icon: <FileText size={16} className="text-[#4CAF50]" />,
  },
  {
    key: 'deep',
    title: 'Deep',
    description: 'Full report with headings.',
    icon: <Newspaper size={16} className="text-[#2196F3]" />,
  },
];

/**
 * Answer length, as a popover rather than four inline buttons.
 *
 * The inline version ate horizontal space the follow-up input does not have on
 * a phone, and positioning its moving pill was a recurring source of layout
 * bugs. A trigger plus a panel is the same shape as the research-depth control
 * beside it.
 */
const AnswerLength = () => {
  const { answerStyle, setAnswerStyle } = useChat();

  const current =
    STYLES.find((s) => s.key === (answerStyle || 'auto')) ?? STYLES[0];

  /* Hover-to-open only where hovering is real. A touch device reports a hover
   * event on first tap, which would open the panel and then immediately treat
   * the same tap as a selection. Phones get click, which Popover already
   * handles; pointers get hover as well. */
  const [hoverCapable, setHoverCapable] = useState(false);

  useEffect(() => {
    setHoverCapable(
      window.matchMedia('(hover: hover) and (pointer: fine)').matches,
    );
  }, []);

  const buttonRef = useRef<HTMLButtonElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const openOnHover = (open: boolean) => {
    if (!hoverCapable) return;
    clearTimeout(closeTimer.current);
    if (!open) buttonRef.current?.click();
  };

  const closeOnLeave = (open: boolean) => {
    if (!hoverCapable) return;
    /* A short delay so moving the pointer from the trigger to the panel does
     * not close it on the way. */
    closeTimer.current = setTimeout(() => {
      if (open) buttonRef.current?.click();
    }, 180);
  };

  useEffect(() => () => clearTimeout(closeTimer.current), []);

  return (
    <Popover className="relative">
      {({ open }) => (
        <div
          onMouseEnter={() => openOnHover(open)}
          onMouseLeave={() => closeOnLeave(open)}
        >
          <PopoverButton
            ref={buttonRef}
            type="button"
            aria-label={`Answer length: ${current.title}`}
            title={`Answer length — ${current.title}: ${current.description}`}
            className="p-2 text-black/50 dark:text-white/50 rounded-xl hover:bg-light-secondary dark:hover:bg-dark-secondary active:scale-95 transition duration-200 hover:text-black dark:hover:text-white focus:outline-none"
          >
            <div className="flex flex-row items-center space-x-1">
              {current.icon}
              <ChevronDown
                size={16}
                className={cn(
                  open ? 'rotate-180' : 'rotate-0',
                  'transition duration-200',
                )}
              />
            </div>
          </PopoverButton>

          <AnimatePresence>
            {open && (
              <PopoverPanel
                className="absolute z-10 w-64 md:w-[250px] bottom-full mb-2 left-0"
                static
              >
                <motion.div
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.9 }}
                  transition={{ duration: 0.1, ease: 'easeOut' }}
                  className="origin-bottom-left flex flex-col space-y-1 bg-light-primary dark:bg-dark-primary border rounded-lg border-light-200 dark:border-dark-200 w-full p-2 max-h-[70vh] overflow-y-auto"
                >
                  {STYLES.map((style) => (
                    <PopoverButton
                      key={style.key}
                      onClick={() => setAnswerStyle(style.key)}
                      className={cn(
                        'p-2 rounded-lg flex flex-col items-start justify-start text-start space-y-1 duration-200 cursor-pointer transition focus:outline-none',
                        current.key === style.key
                          ? 'bg-light-secondary dark:bg-dark-secondary'
                          : 'hover:bg-light-secondary dark:hover:bg-dark-secondary',
                      )}
                    >
                      <div className="flex flex-row items-center space-x-1 text-black dark:text-white">
                        {style.icon}
                        <p className="text-xs font-medium">{style.title}</p>
                      </div>
                      <p className="text-black/70 dark:text-white/70 text-xs">
                        {style.description}
                      </p>
                    </PopoverButton>
                  ))}
                </motion.div>
              </PopoverPanel>
            )}
          </AnimatePresence>
        </div>
      )}
    </Popover>
  );
};

export default AnswerLength;
