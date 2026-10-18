import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { cn } from '../lib/utils';
import { Avatar } from './avatar';
import { Badge } from './badge';
import { Button } from './button';
import { EmptyState } from './empty-state';
import { Field, FieldDescription, FieldError, FieldLabel } from './field';
import { Form } from './form';
import { Input } from './input';
import { Textarea } from './textarea';

describe('Button', () => {
  it('is a 36px accent button with 8px corners by default, 44px below the desktop layout', () => {
    const html = renderToStaticMarkup(<Button>Send it</Button>);
    expect(html).toMatch(/^<button type="button"/);
    expect(html).toContain('bg-primary');
    expect(html).toContain('min-h-11');
    expect(html).toContain('lg:min-h-9');
    expect(html).toContain('px-3.5 py-2');
    expect(html).toContain('rounded-lg');
    expect(html).not.toContain('rounded-full');
  });

  it('has a 32px small size, 40px below the desktop layout', () => {
    const html = renderToStaticMarkup(<Button size="small">Undo</Button>);
    expect(html).toContain('min-h-10');
    expect(html).toContain('lg:min-h-8');
  });

  it('lets a caller override its classes', () => {
    const html = renderToStaticMarkup(
      <Button variant="secondary" className="px-3">
        Change it
      </Button>,
    );
    expect(html).toContain('border-input');
    expect(html).toContain('px-3');
    expect(html).not.toContain('px-3.5');
  });
});

describe('Badge', () => {
  it('renders the attention pill', () => {
    const html = renderToStaticMarkup(<Badge variant="attention">New lead</Badge>);
    expect(html).toMatch(/^<span data-slot="badge" data-variant="attention" class="/);
    expect(html).toContain('rounded-full');
    expect(html).toContain('bg-attention text-attention-foreground');
    expect(html).toMatch(/>New lead<\/span>$/);
  });

  it('writes what the assistant did in its own color', () => {
    const html = renderToStaticMarkup(<Badge variant="assistant">Drafted</Badge>);
    expect(html).toContain('bg-assistant text-assistant-foreground');
  });

  it('can render as another element', () => {
    const html = renderToStaticMarkup(<Badge render={<strong />}>6</Badge>);
    expect(html).toMatch(/^<strong data-slot="badge"/);
    expect(html).toMatch(/>6<\/strong>$/);
  });
});

describe('Avatar', () => {
  it('shows the initials and hides itself from screen readers', () => {
    const html = renderToStaticMarkup(<Avatar fallback="HL" size="small" />);
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('>HL<');
    expect(html).toContain('size-8');
    expect(html).toContain('bg-avatar-4');
  });

  it('keeps showing the initials while a photo loads', () => {
    const html = renderToStaticMarkup(<Avatar fallback="DB" src="/photos/dana.jpg" tint={2} />);
    expect(html).toContain('>DB<');
    expect(html).toContain('bg-avatar-2');
  });
});

describe('EmptyState', () => {
  it('has a heading and a description', () => {
    const html = renderToStaticMarkup(
      <EmptyState title="No contacts yet" description="People you add show up here." />,
    );
    expect(html).toContain('<h2 class="text-xl font-semibold">No contacts yet</h2>');
    expect(html).toContain('People you add show up here.');
    expect(html).not.toContain('aria-hidden');
  });

  it('shows an icon and an action when given', () => {
    const html = renderToStaticMarkup(
      <EmptyState
        title="No deals yet"
        description="Deals show up here."
        icon={<svg />}
        action={<Button>Add a deal</Button>}
      />,
    );
    expect(html).toContain('<span aria-hidden="true"');
    expect(html).toContain('Add a deal');
  });
});

describe('Input and Textarea', () => {
  it('are 36px inputs with 6px corners and body text, 44px below the desktop layout', () => {
    const input = renderToStaticMarkup(<Input name="name" />);
    expect(input).toMatch(/^<input /);
    expect(input).toContain('min-h-11');
    expect(input).toContain('lg:min-h-9');
    expect(input).toContain('rounded-control');
    expect(input).toContain('text-md');

    const textarea = renderToStaticMarkup(<Textarea name="description" />);
    expect(textarea).toMatch(/^<textarea rows="2"/);
    expect(textarea).toContain('rounded-control');
    expect(textarea).toContain('resize-y');
  });
});

describe('Form and Field', () => {
  const tagForm = (errors: Record<string, string>) =>
    renderToStaticMarkup(
      <Form errors={errors}>
        <Field name="name">
          <FieldLabel>Name</FieldLabel>
          <Input />
          <FieldDescription>Lower case reads best.</FieldDescription>
          <FieldError />
        </Field>
        <Field name="description">
          <FieldLabel>What it means</FieldLabel>
          <Textarea />
          <FieldError />
        </Field>
      </Form>,
    );

  it('labels each control', () => {
    const html = tagForm({});
    for (const [label, control] of [
      ['Name', 'input'],
      ['What it means', 'textarea'],
    ] as const) {
      const id = new RegExp(`<label[^>]* for="([^"]+)"[^>]*>${label}</label>`).exec(html)?.[1];
      expect(id).toBeDefined();
      expect(html).toMatch(new RegExp(`<${control}[^>]* id="${String(id)}"`));
    }
    expect(html).not.toContain('aria-invalid');
  });

  it("shows the error it's given under that field, and marks the control invalid", () => {
    const html = tagForm({ name: 'A tag with this name already exists.' });
    expect(html).toMatch(/<input[^>]* aria-invalid="true"/);
    expect(html).toMatch(
      /<div[^>]*data-slot="field-error"[^>]*text-destructive[^>]*>A tag with this name already exists\.<\/div>/,
    );
    expect(html).not.toMatch(/<textarea[^>]* aria-invalid/);
  });
});

describe('cn', () => {
  it('lets the later of two conflicting classes win', () => {
    expect(cn('text-sm text-foreground', 'text-muted-foreground')).toBe(
      'text-sm text-muted-foreground',
    );
    expect(cn('px-6', false, undefined, 'px-3')).toBe('px-3');
  });
});
