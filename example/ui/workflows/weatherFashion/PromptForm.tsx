import { useState } from "react";

const sizes = {
  md: { input: "px-4 py-2", button: "px-4 py-2" },
  lg: { input: "px-4 py-3 text-lg", button: "px-5 py-3" },
};

/**
 * A one-line input with a submit button. Clears on submit, and puts the
 * text back if `onSubmit` rejects so nothing typed is lost.
 */
export function PromptForm({
  id,
  label,
  placeholder,
  submitLabel,
  onSubmit,
  size = "md",
  className = "",
}: {
  id: string;
  label: string;
  placeholder: string;
  submitLabel: string;
  onSubmit: (value: string) => Promise<unknown>;
  size?: keyof typeof sizes;
  className?: string;
}) {
  const [value, setValue] = useState("");
  return (
    <form
      className={`flex gap-2 ${className}`}
      onSubmit={(e) => {
        e.preventDefault();
        const text = value.trim();
        if (!text) return;
        setValue("");
        onSubmit(text).catch(() => setValue(text));
      }}
    >
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <input
        id={id}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className={`flex-1 rounded-lg border-2 border-indigo-100 focus:outline-hidden focus:border-indigo-500 ${sizes[size].input}`}
        placeholder={placeholder}
      />
      <button
        type="submit"
        disabled={!value.trim()}
        className={`rounded-lg bg-indigo-600 text-white font-medium hover:bg-indigo-500 disabled:opacity-50 ${sizes[size].button}`}
      >
        {submitLabel}
      </button>
    </form>
  );
}
