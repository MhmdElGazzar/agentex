# Test design conventions — demo-shop

Project-specific conventions the **test-design** skill reads before designing test cases.

## Persona

The persona prefix used in every test case title (`<Persona> || <Feature> || <condition>`):

```
SME User
```

## Feature map

Which feature each story belongs to (used for the `<Feature>` part of titles):

| Feature | Story |
|---|---|
| Step5 | 2201 |

## Standard setup steps

The ActionSteps every test case starts with (adjust prerequisites per step):

1. `Given the customer lands on the example-portal homepage`
2. `When the customer clicks "Get started" and completes Steps 1-4`

## Languages for text checks

Languages every "page text" test case must cover:

```
EN, AR
```

## Project-specific condition categories

Elements that always get their own test case when a story includes them (in addition to the
skill's generic categories):

| Element | Test case title | What to check |
|---|---|---|
| helper box | `user checks the helper box` | Q&A text in every supported language |

## Design reference

Where the design link lives in stories:

```
story description, under 'Figma Design Link'
```
