const target = typeof chrome !== 'undefined' && chrome.runtime?.getURL
  ? chrome.runtime.getURL('workspace.html#settings')
  : '/workspace.html#settings';
location.replace(target);
