# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

React + Vite + plain CSS, served by a local Node 26 process. Runs on one Mac at `localhost`.

## Users

One person at a Mac who collects business cards and processes them in occasional batches, for example after an event. They won't remember how the app works between uses, so every screen must explain itself. Their main concern is keeping wrong values out of the spreadsheet.

## Product Purpose

Turn business card images into verified spreadsheet rows with the columns Name, Position, Company, Email, Phone and Website, ready to paste into Excel or Google Sheets. Success means every value is exactly right and pastes intact, phone numbers especially.

## Positioning

Nothing reaches the spreadsheet on one unchecked reading. Every card is read three times and checked automatically, and anything uncertain is shown to a person beside the card image before it can be copied.

## Operating Context

- One upload can hold up to 1,000 cards. A single image can contain 30 or more cards, such as a photo or scan of cards laid out on a table.
- Inputs are photos and scans: JPG, PNG, WEBP, HEIC, PDF, ZIP and folders.
- The output is pasted into Excel or Google Sheets, or downloaded as `.xlsx` or CSV.
- All model calls use GPT-6 Luna through the user's own OpenAI API key.

## Capabilities and Constraints

- Confirmed scope: single user, this Mac only, no sign-in, no public hosting, no batch mode.
- Cards that can't be verified must be confirmed by a person before they can be copied.
- Open: "anyone can upload" needs a hosted version, which isn't in this release.

## Brand Commitments

- Name: Card Scanner.
- Look: the standard tool look, chosen by the user. Clean, familiar and restrained, held to the craft level of Apple Numbers and Linear.

## Evidence on Hand

No real cards, customers or measured accuracy results exist yet. Don't state accuracy, speed or cost as fact in the interface until they have been measured.

## Product Principles

- Never guess: a blank or a flagged value beats a confident wrong one.
- Never lose a card: every file and card is accounted for on screen.
- Always say what happens next, because the user is here only occasionally.
- Show the evidence: put the card image beside any value someone is asked to judge.
