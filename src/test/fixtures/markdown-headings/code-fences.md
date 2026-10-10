# Real heading

Expected: only "Real heading" and "After the fences" — every `#` line inside a fence is code.

```bash
# not a heading: shell comment
## not a heading either
```

~~~python
# python comment
~~~

````md
```
# still inside the outer four-backtick fence
```
````

    # indented by four spaces: code block, not a heading

## After the fences
