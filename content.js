let REPLACEMENTS = [];
let ALLOWLIST = [];

const PLACEHOLDER_PREFIX = "\x00ALLOW_";
const PLACEHOLDER_SUFFIX = "\x00";

const originalText = new WeakMap();

function loadReplacements() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "GET_REPLACEMENTS" }, (response) => {
      if (response?.ok) {
        REPLACEMENTS = response.replacements.map(({ pattern, replacement, flags }) => {
          const compiled = new RegExp(pattern, flags);
          return [compiled, replacement];
        });
        ALLOWLIST = response.allowlist || [];
      }
      resolve();
    });
  });
}

function applyWithAllowlist(text) {
  if (ALLOWLIST.length === 0) {
    for (const [pattern, replacement] of REPLACEMENTS) {
      text = text.replaceAll(pattern, replacement);
    }
    return text;
  }

  const placeholderMap = {};
  ALLOWLIST.forEach((word, i) => {
    const placeholder = `${PLACEHOLDER_PREFIX}${i}${PLACEHOLDER_SUFFIX}`;
    const regex = new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    text = text.replace(regex, (match) => {
      placeholderMap[placeholder] = match;
      return placeholder;
    });
  });

  for (const [pattern, replacement] of REPLACEMENTS) {
    text = text.replaceAll(pattern, replacement);
  }

  for (const [placeholder, original] of Object.entries(placeholderMap)) {
    text = text.replaceAll(placeholder, original);
  }

  return text;
}

function replaceInTextNode(node) {
  if (!originalText.has(node)) {
    originalText.set(node, node.textContent);
  }

  const text = applyWithAllowlist(originalText.get(node));
  if (node.textContent !== text) {
    node.textContent = text;
  }
}

function isInputField(node) {
  const parent = node.parentElement;
  if (!parent) return true;
  const tag = parent.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA") return true;

  // רק אם ההורה הישיר הוא contenteditable — לא הורים רחוקים יותר
  // זה מונע חסימת הודעות צ'אט שנמצאות *בתוך* אזור שיש בו שדה קלט
  if (parent.isContentEditable && parent.getAttribute("contenteditable") === "true") return true;

  return false;
}

function walkDOM(root) {
  const walker = document.createTreeWalker(
    root,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        const tag = parent.tagName;
        if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT") {
          return NodeFilter.FILTER_REJECT;
        }
        if (isInputField(node)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    }
  );

  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  nodes.forEach(replaceInTextNode);
}

// תמיכה ב-Shadow DOM (נדרש עבור YouTube Live Chat)
function walkShadowDOM(root) {
  walkDOM(root);

  const elements = root.querySelectorAll("*");
  for (const el of elements) {
    if (el.shadowRoot) {
      walkDOM(el.shadowRoot);
      walkShadowDOM(el.shadowRoot);
    }
  }
}

function observeTarget(target) {
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === "characterData") {
        const node = mutation.target;
        if (!isInputField(node)) {
          originalText.set(node, node.textContent);
          replaceInTextNode(node);
        }
        continue;
      }
      for (const node of mutation.addedNodes) {
        if (node.nodeType === Node.TEXT_NODE) {
          if (!isInputField(node)) replaceInTextNode(node);
        } else if (node.nodeType === Node.ELEMENT_NODE) {
          // בדוק גם Shadow DOM של אלמנטים חדשים
          walkShadowDOM(node);

          // אם האלמנט החדש עצמו יש לו shadow root, עקוב אחריו
          if (node.shadowRoot) {
            observeTarget(node.shadowRoot);
          }
        }
      }
    }
  });

  observer.observe(target, {
    childList: true,
    subtree: true,
    characterData: true
  });

  return observer;
}

// עקוב אחר shadow roots חדשים שנוצרים דינמית (כמו YouTube chat)
function observeForShadowRoots(root) {
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          if (node.shadowRoot) {
            walkDOM(node.shadowRoot);
            observeTarget(node.shadowRoot);
            observeForShadowRoots(node.shadowRoot);
          }
          // בדוק צאצאים
          const shadowed = node.querySelectorAll?.("*") || [];
          for (const el of shadowed) {
            if (el.shadowRoot) {
              walkDOM(el.shadowRoot);
              observeTarget(el.shadowRoot);
              observeForShadowRoots(el.shadowRoot);
            }
          }
        }
      }
    }
  });

  observer.observe(root, { childList: true, subtree: true });
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "CATEGORIES_UPDATED") {
    loadReplacements().then(() => walkShadowDOM(document.body));
  }
});

loadReplacements().then(() => {
  walkShadowDOM(document.body);
  observeTarget(document.body);
  observeForShadowRoots(document.body);
});