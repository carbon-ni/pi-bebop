local M = {}

function M.hello()
  return "Hello from pi-intray.nvim"
end

function M.setup()
  vim.api.nvim_create_user_command("PiIntrayHello", function()
    vim.notify(M.hello())
  end, {
    desc = "Print pi-intray hello world",
  })
end

return M
