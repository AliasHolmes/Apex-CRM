import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { Bot, BotMessageSquare, Maximize2, Minimize2, Send, Sparkles, X } from 'lucide-react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import type { Lead } from '@/types';
import { LEAD_LINK_SCHEME, linkProspectNames } from '@/lib/linkProspectNames';

type ChatMessage = {
  role: 'user' | 'assistant';
  content: string;
};

interface CrmCopilotProps {
  defaultOpen?: boolean;
  /** Used to turn prospect names in answers into links that open the lead drawer. */
  leads?: readonly Lead[];
  onOpenLead?: (leadId: string) => void;
}

const SUGGESTED_PROMPTS: readonly string[] = [
  'Who should I contact today?',
  'Which prospects have a why-now signal?',
  'Summarize my pipeline by stage',
  'Draft a first message for my best-fit prospect',
];

function MarkdownMessage({
  content,
  nameToId,
  onOpenLead,
}: {
  content: string;
  nameToId: ReadonlyMap<string, string>;
  onOpenLead?: (leadId: string) => void;
}) {
  const linked = useMemo(() => linkProspectNames(content, nameToId), [content, nameToId]);
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      urlTransform={(url) => (url.startsWith(LEAD_LINK_SCHEME) ? url : defaultUrlTransform(url))}
      components={{
        h1: ({ children }) => <h1 className="mb-2 mt-4 text-base font-bold leading-snug text-foreground first:mt-0">{children}</h1>,
        h2: ({ children }) => <h2 className="mb-2 mt-4 text-[15px] font-bold leading-snug text-foreground first:mt-0">{children}</h2>,
        h3: ({ children }) => <h3 className="mb-1.5 mt-3 text-sm font-semibold leading-snug text-foreground first:mt-0">{children}</h3>,
        p: ({ children }) => <p className="mb-3 whitespace-pre-wrap break-words last:mb-0">{children}</p>,
        strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,
        em: ({ children }) => <em className="text-foreground/80">{children}</em>,
        ul: ({ children }) => <ul className="my-3 list-outside list-disc space-y-1.5 pl-5 marker:text-primary">{children}</ul>,
        ol: ({ children }) => <ol className="my-3 list-outside list-decimal space-y-1.5 pl-5 marker:font-semibold marker:text-primary">{children}</ol>,
        li: ({ children }) => <li className="pl-0.5 [&>p]:mb-0">{children}</li>,
        blockquote: ({ children }) => (
          <blockquote className="my-3 border-l-2 border-primary bg-primary/10 py-2 pl-3 pr-2 text-foreground/80">
            {children}
          </blockquote>
        ),
        a: ({ children, href }) => {
          if (href?.startsWith(LEAD_LINK_SCHEME) && onOpenLead) {
            const leadId = decodeURIComponent(href.slice(LEAD_LINK_SCHEME.length));
            return (
              <button
                type="button"
                onClick={() => onOpenLead(leadId)}
                className="rounded-sm font-semibold text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {children}
              </button>
            );
          }
          return (
          <a
            className="font-medium text-primary underline decoration-primary/50 underline-offset-2 transition hover:text-primary hover:decoration-primary"
            href={href}
            target="_blank"
            rel="noreferrer"
          >
            {children}
          </a>
          );
        },
        code: ({ children, className }) => (
          <code className={`${className ?? ''} rounded bg-background/80 px-1.5 py-0.5 font-mono text-[0.84em] text-primary`}>
            {children}
          </code>
        ),
        pre: ({ children }) => (
          <pre className="my-3 max-w-full overflow-x-auto rounded-xl border border-input/80 bg-background p-3 text-xs leading-5 text-foreground [&>code]:bg-transparent [&>code]:p-0">
            {children}
          </pre>
        ),
        table: ({ children }) => (
          <div className="my-3 max-w-full overflow-x-auto rounded-xl border border-input">
            <table className="w-full min-w-80 border-collapse text-left text-xs">{children}</table>
          </div>
        ),
        thead: ({ children }) => <thead className="bg-background/80 text-foreground">{children}</thead>,
        th: ({ children }) => <th className="border-b border-input px-3 py-2 font-semibold">{children}</th>,
        td: ({ children }) => <td className="border-b border-input/60 px-3 py-2 align-top last:border-b-0">{children}</td>,
        hr: () => <hr className="my-4 border-input" />,
      }}
    >
      {linked}
    </ReactMarkdown>
  );
}

export default function CrmCopilot({ defaultOpen = false, leads, onOpenLead }: CrmCopilotProps) {
  const shouldReduceMotion = useReducedMotion();
  const [isOpen, setIsOpen] = useState(defaultOpen);
  const [isExpanded, setIsExpanded] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      role: 'assistant',
      content: "Hi! I'm your **Apex CRM Copilot**. I can analyze your pipeline, summarize leads, or help draft emails. What do you need?",
    },
  ]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const nameToId = useMemo(() => {
    const map = new Map<string, string>();
    for (const lead of leads ?? []) {
      const name = lead.profile?.fullName?.trim();
      // Single-word names are too ambiguous to link safely.
      if (name && name.includes(' ') && !map.has(name)) map.set(name, lead.id);
    }
    return map;
  }, [leads]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const messageInputRef = useRef<HTMLTextAreaElement>(null);
  const wasOpenRef = useRef(false);

  useEffect(() => {
    if (scrollRef.current) {
      const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
      const isNearBottom = scrollHeight - scrollTop - clientHeight < 120;
      if (isNearBottom) {
        scrollRef.current.scrollTo({
          top: scrollHeight,
          behavior: shouldReduceMotion ? 'auto' : 'smooth'
        });
      }
    }
  }, [messages, isLoading, isOpen, shouldReduceMotion]);

  useEffect(() => {
    if (!isOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsOpen(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [isOpen]);

  useEffect(() => {
    const frameId = window.requestAnimationFrame(() => {
      if (isOpen) messageInputRef.current?.focus();
      else if (wasOpenRef.current) triggerRef.current?.focus();
      wasOpenRef.current = isOpen;
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [isOpen]);

  const handleSend = async (promptOverride?: string) => {
    const draft = (promptOverride ?? input).trim();
    if (!draft || isLoading) return;

    const userMessage = draft;
    if (promptOverride === undefined) setInput('');
    setMessages((previous) => [...previous, { role: 'user', content: userMessage }]);
    setIsLoading(true);

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: userMessage }),
      });

      const data = await response.json();
      if (response.ok) {
        setMessages((previous) => [...previous, { role: 'assistant', content: data.text }]);
      } else {
        setMessages((previous) => [
          ...previous,
          { role: 'assistant', content: `**Something went wrong:** ${data.error || 'Failed to get a response.'}` },
        ]);
      }
    } catch {
      setMessages((previous) => [
        ...previous,
        { role: 'assistant', content: '**Connection issue:** I could not reach the copilot. Please try again.' },
      ]);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <>
      <AnimatePresence>
        {!isOpen && (
          <motion.button
            ref={triggerRef}
            type="button"
            initial={shouldReduceMotion ? false : { scale: 0.85, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={shouldReduceMotion ? undefined : { scale: 0.85, opacity: 0 }}
            whileHover={shouldReduceMotion ? undefined : { y: -2, scale: 1.03 }}
            whileTap={shouldReduceMotion ? undefined : { scale: 0.96 }}
            onClick={() => setIsOpen(true)}
            aria-label="Open Apex Copilot"
            className="fixed bottom-5 right-5 z-50 flex h-14 w-14 cursor-pointer items-center justify-center rounded-2xl border border-primary/30 bg-gradient-to-br from-primary to-primary/70 text-primary-foreground shadow-xl shadow-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            <BotMessageSquare className="h-6 w-6" aria-hidden="true" />
            <span className="absolute -right-0.5 -top-0.5 flex h-3 w-3">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-70 motion-reduce:animate-none" />
              <span className="relative inline-flex h-3 w-3 rounded-full border-2 border-border bg-success" />
            </span>
          </motion.button>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {isOpen && (
          <motion.div
            layout
            initial={shouldReduceMotion ? false : { opacity: 0, y: 24, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={shouldReduceMotion ? undefined : { opacity: 0, y: 24, scale: 0.97 }}
            transition={shouldReduceMotion ? { duration: 0 } : { type: 'spring', stiffness: 320, damping: 28 }}
            className={`fixed z-50 flex flex-col ${
              isExpanded
                ? 'inset-0 sm:inset-5'
                : 'inset-x-3 bottom-3 top-3 sm:inset-auto sm:bottom-5 sm:right-5 sm:h-[min(720px,calc(100vh-2.5rem))] sm:w-[min(460px,calc(100vw-2.5rem))]'
            }`}
          >
            <Card
              role="dialog"
              aria-labelledby="copilot-title"
              aria-describedby="copilot-description"
              className={`relative flex h-full min-h-0 flex-col gap-0 overflow-hidden border-input/80 bg-card/95 py-0 shadow-2xl ring-1 ring-border backdrop-blur-2xl ${
                isExpanded ? 'rounded-none sm:rounded-3xl' : 'rounded-3xl'
              }`}
            >
              <div className="pointer-events-none absolute inset-x-0 top-0 h-28 bg-gradient-to-b from-primary/10 to-transparent" />

              <CardHeader className="relative flex flex-row items-center justify-between gap-3 border-b border-border/80 px-4 py-3.5 sm:px-5">
                <div className="flex min-w-0 items-center gap-3">
                  <div className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-primary/30 bg-gradient-to-br from-primary/25 to-primary/10 shadow-inner">
                    <Bot className="h-5 w-5 text-primary" />
                    <span className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-border bg-success" />
                  </div>
                  <div className="min-w-0">
                    <CardTitle id="copilot-title" className="flex items-center gap-1.5 truncate text-sm font-bold tracking-tight text-foreground">
                      Apex Copilot
                      <Sparkles className="h-3.5 w-3.5 text-primary" />
                    </CardTitle>
                    <p id="copilot-description" className="mt-0.5 truncate text-xs font-medium text-muted-foreground">Pipeline intelligence, ready to help</p>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={isExpanded ? 'Restore compact chat' : 'Expand chat to full screen'}
                    aria-pressed={isExpanded}
                    title={isExpanded ? 'Restore compact chat' : 'Expand chat'}
                    className="h-9 w-9 rounded-xl text-muted-foreground hover:bg-muted hover:text-foreground"
                    onClick={() => setIsExpanded((expanded) => !expanded)}
                  >
                    {isExpanded ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Close Apex Copilot"
                    className="h-9 w-9 rounded-xl text-muted-foreground hover:bg-muted hover:text-foreground"
                    onClick={() => setIsOpen(false)}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              </CardHeader>

              <CardContent
                className="custom-scrollbar flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-3 py-5 sm:px-5"
                ref={scrollRef}
                aria-live="polite"
              >
                {messages.map((message, index) => {
                  const isUser = message.role === 'user';

                  return (
                    <div
                      key={index}
                      className={`flex min-w-0 gap-2.5 ${isExpanded ? 'w-full max-w-5xl self-center' : ''} ${
                        isUser ? 'justify-end' : 'justify-start'
                      }`}
                    >
                      {!isUser && (
                        <div className="mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-primary/20 bg-primary/10">
                          <Bot className="h-3.5 w-3.5 text-primary" />
                        </div>
                      )}
                      <div className={`min-w-0 ${isUser ? 'max-w-[86%]' : 'max-w-[calc(100%-2.375rem)]'}`}>
                        <p className={`mb-1.5 px-1 text-xs font-semibold uppercase tracking-[0.12em] ${isUser ? 'text-right text-primary/80' : 'text-muted-foreground'}`}>
                          {isUser ? 'You' : 'Copilot'}
                        </p>
                        <div
                          className={`min-w-0 overflow-hidden rounded-2xl px-3.5 py-3 text-[13px] leading-6 shadow-sm sm:px-4 ${
                            isUser
                              ? 'rounded-br-md bg-gradient-to-br from-primary to-primary/70 text-primary-foreground shadow-primary/20'
                              : 'rounded-bl-md border border-input/80 bg-muted/75 text-foreground/80 shadow-black/10'
                          }`}
                        >
                          {isUser ? (
                            <p className="whitespace-pre-wrap break-words">{message.content}</p>
                          ) : (
                            <MarkdownMessage content={message.content} nameToId={nameToId} onOpenLead={onOpenLead} />
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}

                {messages.length === 1 && !isLoading && (
                  <div className={`flex flex-wrap gap-2 ${isExpanded ? 'mx-auto w-full max-w-5xl' : ''}`} role="group" aria-label="Suggested questions">
                    {SUGGESTED_PROMPTS.map((prompt) => (
                      <button
                        key={prompt}
                        type="button"
                        onClick={() => void handleSend(prompt)}
                        className="rounded-full border border-primary/30 bg-primary/10 px-3 py-1.5 text-left text-xs font-semibold text-primary transition-colors hover:bg-primary/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
                      >
                        {prompt}
                      </button>
                    ))}
                  </div>
                )}

                {isLoading && (
                  <div className="flex items-start gap-2.5" role="status" aria-label="Copilot is thinking">
                    <div className="mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-primary/20 bg-primary/10">
                      <Bot className="h-3.5 w-3.5 text-primary" />
                    </div>
                    <div>
                      <p className="mb-1.5 px-1 text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">Copilot</p>
                      <div className="flex h-11 items-center gap-1.5 rounded-2xl rounded-bl-md border border-input/80 bg-muted/75 px-4">
                        {[0, 1, 2].map((dot) => (
                          <span
                            key={dot}
                            className="h-1.5 w-1.5 animate-bounce rounded-full bg-primary motion-reduce:animate-none"
                            style={{ animationDelay: `${dot * 140}ms` }}
                          />
                        ))}
                      </div>
                    </div>
                  </div>
                )}
              </CardContent>

              <div className="relative border-t border-border/80 bg-card/90 p-3 sm:p-4">
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    handleSend();
                  }}
                  className={`flex items-end gap-2 rounded-2xl border border-input/80 bg-background/80 p-1.5 shadow-inner transition focus-within:border-primary/70 focus-within:ring-2 focus-within:ring-ring/15 ${
                    isExpanded ? 'mx-auto w-full max-w-5xl' : ''
                  }`}
                >
                  <Textarea
                    ref={messageInputRef}
                    value={input}
                    onChange={(event) => setInput(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && !event.shiftKey) {
                        event.preventDefault();
                        handleSend();
                      }
                    }}
                    rows={1}
                    placeholder="Ask about your pipeline..."
                    aria-label="Message Apex Copilot"
                    className="max-h-32 min-h-10 flex-1 resize-none border-0 bg-transparent px-2.5 py-2.5 text-sm leading-5 text-foreground shadow-none placeholder:text-muted-foreground focus-visible:ring-0"
                  />
                  <Button
                    type="submit"
                    size="icon"
                    aria-label="Send message"
                    disabled={!input.trim() || isLoading}
                    className="h-10 w-10 shrink-0 rounded-xl bg-primary text-primary-foreground shadow-lg shadow-primary/30 hover:bg-primary/90 disabled:bg-muted disabled:text-muted-foreground disabled:opacity-100"
                  >
                    <Send className="h-4 w-4" />
                  </Button>
                </form>
                <p className={`mt-2 px-1 text-xs text-muted-foreground ${isExpanded ? 'mx-auto w-full max-w-5xl' : ''}`}>
                  Enter to send - Shift + Enter for a new line
                </p>
              </div>
            </Card>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
