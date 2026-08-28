# Test design conventions — Sample QA Project

Project-specific conventions the **test-design** skill reads before designing test cases.

## Persona

The persona prefix used in every test case title (`<Persona> || <Feature> || <condition>`):

```
Retail User
```

## Feature map

| Feature | Story |
|---|---|
| Checkout | PROJ-42 |
| Login | PROJ-17 |

## Standard setup steps

1. `Given the customer lands on the shop homepage`
2. `When the customer signs in and adds one item to the cart`

## Languages for text checks

```
EN, AR
```

## Project-specific condition categories

| Element | Test case title | What to check |
|---|---|---|
| order summary panel | `user checks the order summary section` | totals match the cart; all fields read-only |

## Design reference

```
story description, under "Design Link"
```
