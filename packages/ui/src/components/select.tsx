import { Select as SelectPrimitive } from '@base-ui/react/select';
import { Check, ChevronDown } from 'lucide-react';
import {
  Fragment,
  isValidElement,
  useRef,
  type ReactElement,
  type ReactNode,
  type Ref,
} from 'react';
import { cn } from '../lib/utils';

interface Choice {
  readonly value: string;
  readonly label: ReactNode;
  readonly disabled: boolean;
}

interface OptionProps {
  readonly value?: string | number;
  readonly children?: ReactNode;
  readonly disabled?: boolean;
}

/** Declarative options stay beside the field, including conditional and mapped choices. */
function choicesOf(children: ReactNode): Choice[] {
  if (Array.isArray(children)) return children.flatMap((child: ReactNode) => choicesOf(child));
  const child = children;
  if (!isValidElement<OptionProps>(child)) return [];
  if (child.type === Fragment) return choicesOf(child.props.children);
  if (child.type !== 'option') throw new TypeError('Select children must be options.');
  const value = child.props.value;
  if (value === undefined) throw new TypeError('Select options need an explicit value.');
  return [
    {
      value: String(value),
      label: child.props.children,
      disabled: child.props.disabled ?? false,
    },
  ];
}

interface CommonProps {
  readonly children: ReactNode;
  readonly name?: string;
  readonly id?: string;
  readonly required?: boolean;
  readonly disabled?: boolean;
  readonly className?: string;
  readonly ref?: Ref<HTMLButtonElement>;
  readonly 'aria-label'?: string;
  readonly 'aria-labelledby'?: string;
  readonly 'aria-describedby'?: string;
  readonly 'aria-invalid'?: boolean | 'true' | 'false' | 'grammar' | 'spelling';
  readonly 'data-field-control'?: boolean;
}

export type SelectProps = CommonProps &
  (
    | {
        readonly multiple?: false;
        readonly value?: string;
        readonly defaultValue?: string;
        readonly onValueChange?: (value: string) => void;
      }
    | {
        readonly multiple: true;
        readonly value?: readonly string[];
        readonly defaultValue?: readonly string[];
        readonly onValueChange?: (value: string[]) => void;
      }
  );

/** Base UI 1.8 owns keyboard/typeahead, Field/Form integration and popup positioning.
 * https://base-ui.com/react/components/select#positioning
 */
export function Select({ ref, ...props }: SelectProps): ReactElement {
  const keyboardChangeRef = useRef(false);
  const choices = choicesOf(props.children);
  const disabled = props.disabled === true || choices.length === 0;
  const initial =
    props.defaultValue ?? (props.multiple === true ? [] : (choices[0]?.value ?? null));
  const value =
    props.value === undefined
      ? undefined
      : typeof props.value === 'string'
        ? props.value
        : [...props.value];
  const defaultValue = initial === null || typeof initial === 'string' ? initial : [...initial];
  return (
    <SelectPrimitive.Root<string, boolean>
      id={props.id}
      name={props.name}
      required={props.required}
      disabled={disabled}
      multiple={props.multiple === true}
      items={choices}
      value={value}
      defaultValue={defaultValue}
      onValueChange={(value, details) => {
        // Base UI 1.8's Positioner can restore the initial value as items unmount.
        // Controlled callers own replacement choices after an asynchronous refusal.
        // Closed-trigger typeahead also uses reason "none", but runs during keydown.
        if (
          props.value !== undefined &&
          details.reason === 'none' &&
          details.event.type === 'base-ui' &&
          !keyboardChangeRef.current
        ) {
          details.cancel();
          return;
        }
        if (props.multiple === true) {
          if (Array.isArray(value)) props.onValueChange?.(value);
        } else if (typeof value === 'string') props.onValueChange?.(value);
      }}
    >
      <SelectPrimitive.Trigger
        ref={ref}
        onKeyDownCapture={() => {
          keyboardChangeRef.current = true;
          queueMicrotask(() => {
            keyboardChangeRef.current = false;
          });
        }}
        aria-label={props['aria-label']}
        aria-labelledby={props['aria-labelledby']}
        aria-describedby={props['aria-describedby']}
        aria-invalid={props['aria-invalid']}
        data-slot="select-trigger"
        data-field-control={props['data-field-control']}
        className={cn(
          'flex min-h-11 w-full min-w-0 items-center justify-between gap-2 rounded-control border border-input bg-card px-3 py-1.5 text-left text-md font-normal text-foreground disabled:cursor-not-allowed disabled:opacity-50 data-invalid:border-destructive lg:min-h-9',
          props.className,
        )}
      >
        <SelectPrimitive.Value className="min-w-0 truncate">
          {(selected: unknown) => {
            const values =
              typeof selected === 'string'
                ? [selected]
                : Array.isArray(selected)
                  ? selected.filter((value: unknown): value is string => typeof value === 'string')
                  : [];
            return (
              <span
                data-slot="select-value"
                data-value={props.multiple === true ? JSON.stringify(values) : (values[0] ?? '')}
              >
                {values.length === 0
                  ? '—'
                  : values.map((value, index) => (
                      <Fragment key={value}>
                        {index === 0 ? null : ', '}
                        {choices.find((choice) => choice.value === value)?.label ?? '—'}
                      </Fragment>
                    ))}
              </span>
            );
          }}
        </SelectPrimitive.Value>
        <SelectPrimitive.Icon>
          <ChevronDown
            aria-hidden
            className="size-[18px] shrink-0 text-muted-foreground"
            strokeWidth={1.8}
          />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Positioner
          align="start"
          alignItemWithTrigger={false}
          sideOffset={6}
          className="isolate z-[70] max-w-(--available-width) outline-none"
        >
          <SelectPrimitive.Popup
            data-slot="select-popup"
            className="max-h-(--available-height) min-w-(--anchor-width) max-w-(--available-width) overflow-y-auto overscroll-contain rounded-card border bg-popover p-1.5 text-popover-foreground shadow-lg outline-none"
          >
            <SelectPrimitive.List>
              {choices.map((choice) => (
                <SelectPrimitive.Item
                  key={choice.value}
                  value={choice.value}
                  data-value={choice.value}
                  disabled={choice.disabled}
                  className="relative flex min-h-11 cursor-pointer items-center gap-2 rounded-control py-2 pr-9 pl-3 text-md outline-none select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground data-disabled:cursor-not-allowed data-disabled:opacity-50 lg:min-h-9"
                >
                  <SelectPrimitive.ItemText className="min-w-0 wrap-break-word">
                    {choice.label}
                  </SelectPrimitive.ItemText>
                  <SelectPrimitive.ItemIndicator className="absolute right-3 text-primary">
                    <Check aria-hidden className="size-4" />
                  </SelectPrimitive.ItemIndicator>
                </SelectPrimitive.Item>
              ))}
            </SelectPrimitive.List>
          </SelectPrimitive.Popup>
        </SelectPrimitive.Positioner>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}
