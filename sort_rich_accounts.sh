#!/bin/bash
# sort_rich_accounts.sh
# Sorts lines from rich-accounts.txt by diamond count (descending)
# Keeps the full line text (including | separators)
# Removes any dashed divider lines

INPUT_FILE="rich-accounts.txt"
OUTPUT_FILE="sorted-rich-accounts.txt"

# Check if input file exists
if [[ ! -f "$INPUT_FILE" ]]; then
    echo "❌ Error: $INPUT_FILE not found."
    exit 1
fi

# Process, sort, and preserve formatting
grep -v '^-*$' "$INPUT_FILE" | \
awk '{
    match($0, /diamonds:([0-9]+)/, arr)
    diamonds = (arr[1] == "" ? 0 : arr[1])
    print diamonds "\t" $0
}' | \
sort -k1,1nr | \
cut -f2- > "$OUTPUT_FILE"

echo "✅ Sorting complete!"
echo "💎 Results saved to $OUTPUT_FILE"
