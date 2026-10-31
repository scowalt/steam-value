---
name: Steam Value
description: Compact game comparison using 0build dark-theme components
colors:
  background: "oklch(14.1% 0.005 285.823)"
  foreground: "oklch(96.7% 0.001 286.375)"
  card: "#151518"
  muted: "oklch(70.5% 0.015 286.067)"
  primary: "oklch(96.7% 0.001 286.375)"
  primary-foreground: "oklch(21% 0.006 285.885)"
  success: "oklch(69.6% 0.17 162.48)"
  success-foreground: "oklch(76.5% 0.177 163.223)"
  info: "oklch(62.3% 0.214 259.815)"
  info-foreground: "oklch(70.7% 0.165 254.624)"
  warning: "oklch(76.9% 0.188 70.08)"
  warning-foreground: "oklch(82.8% 0.189 84.429)"
typography:
  heading:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
    fontSize: "calc(0.875rem * 2.441)"
    fontWeight: 700
    lineHeight: 1.15
    letterSpacing: "-0.025em"
  body:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: "1.25rem"
  card-title:
    fontSize: "1rem"
    fontWeight: 600
    lineHeight: 1.4
  label:
    fontSize: "0.75rem"
    fontWeight: 600
    lineHeight: "1rem"
rounded:
  control: "0.375rem"
  checkbox: "0.125rem"
spacing:
  small: "0.5rem"
  compact: "0.75rem"
  medium: "1rem"
  section: "1.5rem"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-foreground}"
    rounded: "{rounded.control}"
    height: "2.1875rem"
  card:
    backgroundColor: "{colors.card}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.control}"
    padding: "1rem"
  input:
    textColor: "{colors.foreground}"
    rounded: "{rounded.control}"
    height: "2.75rem"
---

# Design System: Steam Value

## Overview

0build's dark, compact component system supports a game-comparison task. Tables and native controls lead; cards adapt the rankings to small screens. The system is intentionally conventional and information-dense, as approved in issue #39.

## Colors

Use the pinned 0build semantic tokens. Neutral foregrounds carry names and controls; muted text carries secondary facts. Success green identifies offers and positive game markers, information blue identifies ownership/multiplayer, and warning amber identifies Early Access/partial controller support and recoverable errors. Text labels always carry the meaning alongside colour.

Status labels use their semantic colour at 12% opacity for the fill and 24% for the border, with the contrasting dark-theme foreground. Input borders use white at 45%; ordinary surface dividers use white at 12%. Focus uses the information foreground.

## Typography

Use the system sans stack; do not introduce a remote font dependency. The compact base, heading and label roles are defined above. Card titles wrap; scores and statistics use tabular numerals. Keep descriptive copy to at most 72 characters per line where space permits. HLTB estimates and recorded Playtime retain distinct labels.

## Layout

The fluid shell is capped at 1600px with page padding from 1rem to 2.5rem. Section gaps are 1.5rem. Filters use grouped native checkboxes and paired selects; the panel becomes one column at 1100px, the header stacks at 640px, and checkbox labels become a single column below 350px.

Rankings switch from the comparison table to a responsive card grid at 900px. City-builder tables retain a scrollable container on narrow screens. Neither view may produce page-wide horizontal overflow.

## Elevation & Depth

Use 0build's shallow ambient shadows and subtle surface borders. No extra decorative glow, texture or background imagery. Shadows and motion values are recorded in the sidecar; reduced-motion preferences remove transitions and animations.

## Shapes

Use the shared control radius for cards, inputs, buttons and status labels. Native multi-select checkboxes use tighter square corners, not radio-like circles. Borders and visible focus define interactive boundaries.

## Components

- **Buttons and navigation:** 0build primary/default/secondary/ghost variants; native links for switching existing views, with `aria-current` identifying the current view. Mobile view links have a 44px minimum height.
- **Forms:** labelled native checkboxes, selects and search inputs. Preserve native select arrows and explicit dark option colours. Keep the filter label click areas at least 44px tall.
- **Tables:** 0build small, divided, hoverable tables. Right-align quantitative columns and retain tabular numerals. City-builder headers contain real buttons and expose `aria-sort`.
- **Cards:** 0build cards/header/footer surround the same ranking information: name/score, three statistics, deals and status labels. They are not a second independent data presentation.
- **Labels:** 0build semantic labels, with contrast-corrected tokens. Deal labels contain underlined links, not click handlers on generic elements.
- **States:** inline status/alert text plus real retry buttons. Keep loading, empty and failure states distinct. Content has no entrance animation.

## Do's and Don'ts

- Do reuse 0build classes and tokens; keep application-specific layout in the `styles` cascade layer.
- Do preserve native keyboard behavior, skip links, visible focus and readable dark-theme options.
- Do verify actual computed contrast when upgrading the vendor pin.
- Don't replace component foundations with lookalike CSS or add a JavaScript runtime for CSS-only controls.
- Don't trade dense, readable game facts for decorative metrics or truncate long game names.
- Don't load UI dependencies from runtime CDNs. See [the integration guide](docs/ui/0build.md) for the pinned source, license and update procedure.
