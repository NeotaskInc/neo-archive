import { cx, emptyStateClass } from "#/lib/ui";

export function NeoArchiveMark({
	animated = false,
	className,
}: {
	animated?: boolean;
	className?: string;
}) {
	return (
		<span
			aria-hidden="true"
			className={cx(
				"neo-archive-mark relative inline-grid shrink-0 place-items-center",
				animated && "neo-archive-mark-animated",
				className,
			)}
		>
			<img
				alt=""
				className="size-full object-contain drop-shadow-[0_10px_22px_var(--brand-shadow)]"
				draggable={false}
				src="/neo-archive-mark.png"
			/>
		</span>
	);
}

export function NeoArchiveLoading({
	label,
	detail,
}: {
	label: string;
	detail?: string;
}) {
	return (
		<div className={cx(emptyStateClass, "neo-archive-state")}>
			<NeoArchiveMark animated className="size-16" />
			<div className="mt-3 text-[14px] font-semibold text-[var(--ink)]">
				{label}
			</div>
			{detail ? (
				<div className="mt-1 text-[13px] text-[var(--ink-soft)]">{detail}</div>
			) : null}
		</div>
	);
}

export function NeoArchiveEmpty({
	label,
	detail,
}: {
	label: string;
	detail?: string;
}) {
	return (
		<div className={cx(emptyStateClass, "neo-archive-state")}>
			<NeoArchiveMark className="size-12 opacity-75" />
			<div className="mt-3 text-[14px] font-semibold text-[var(--ink)]">
				{label}
			</div>
			{detail ? (
				<div className="mt-1 text-[13px] text-[var(--ink-soft)]">{detail}</div>
			) : null}
		</div>
	);
}
