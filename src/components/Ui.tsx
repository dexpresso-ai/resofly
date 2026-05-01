import type { ButtonHTMLAttributes, InputHTMLAttributes, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';

export function Button(props: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'ghost' | 'danger' }) {
  const { variant = 'ghost', className = '', ...rest } = props;
  return <button className={`btn btn-${variant} ${className}`} {...rest} />;
}
export function Input(props: InputHTMLAttributes<HTMLInputElement>) { return <input className="form-input" {...props} />; }
export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) { return <textarea className="form-textarea" {...props} />; }
export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) { return <select className="form-select" {...props} />; }
