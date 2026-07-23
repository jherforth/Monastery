import { useState } from 'react';
import { Loader2 } from 'lucide-react';

export interface ConnectionField {
  key: string;
  label: string;
  type?: 'text' | 'url' | 'password' | 'email';
  placeholder?: string;
  required?: boolean;
  help?: string;
}

interface ConnectionFormProps {
  fields: ConnectionField[];
  submitLabel: string;
  error?: string | null;
  /** Throw (or reject) to signal failure — the form then keeps its values; on success it clears. */
  onSubmit: (values: Record<string, string>) => void | Promise<void>;
}

/**
 * The one "connect a service" form (name / URL / key and friends), replacing the four
 * hand-rolled variants that used to live in the LLM, Hermes, hosting, and git-forge setups.
 */
export function ConnectionForm({ fields, submitLabel, error, onSubmit }: ConnectionFormProps) {
  const [values, setValues] = useState<Record<string, string>>(
    () => Object.fromEntries(fields.map(f => [f.key, ''])),
  );
  const [submitting, setSubmitting] = useState(false);
  const canSubmit = fields.every(f => !f.required || values[f.key]?.trim());

  const handleSubmit = async () => {
    setSubmitting(true);
    try {
      await onSubmit(values);
      setValues(Object.fromEntries(fields.map(f => [f.key, ''])));
    } catch {
      // Parent surfaces the error via the `error` prop; keep the entered values.
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form
      onSubmit={(e) => { e.preventDefault(); if (canSubmit && !submitting) handleSubmit(); }}
      className="space-y-3"
    >
      {fields.map(f => (
        <div key={f.key}>
          <label className="block text-xs font-medium text-monastery-text-secondary mb-1">
            {f.label}{f.required ? '' : ' (optional)'}
          </label>
          <input
            type={f.type || 'text'}
            value={values[f.key] || ''}
            onChange={(e) => setValues(v => ({ ...v, [f.key]: e.target.value }))}
            placeholder={f.placeholder}
            className="w-full px-3 py-2 bg-monastery-dark-bg border border-monastery-dark-border rounded-lg text-sm text-monastery-text-primary placeholder-monastery-text-muted focus:border-monastery-pine focus:outline-none"
          />
          {f.help && <p className="mt-1 text-[11px] text-monastery-text-muted">{f.help}</p>}
        </div>
      ))}
      {error && <p className="text-xs text-red-400">{error}</p>}
      <button
        type="submit"
        disabled={!canSubmit || submitting}
        className="flex items-center gap-2 px-4 py-2 bg-monastery-pine hover:bg-monastery-forest text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
      >
        {submitting && <Loader2 size={14} className="animate-spin" />}
        {submitLabel}
      </button>
    </form>
  );
}
