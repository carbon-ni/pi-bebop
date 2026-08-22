describe("pi_intray", function()
  local plugin
  local created_commands
  local notifications

  before_each(function()
    package.loaded["pi_intray"] = nil
    created_commands = {}
    notifications = {}
    _G.vim = {
      api = {
        nvim_create_user_command = function(name, callback, opts)
          created_commands[name] = { callback = callback, opts = opts }
        end,
      },
      notify = function(message)
        table.insert(notifications, message)
      end,
    }
    plugin = require("pi_intray")
  end)

  after_each(function()
    _G.vim = nil
  end)

  it("returns hello world message", function()
    assert.equals("Hello from pi-intray.nvim", plugin.hello())
  end)

  it("registers PiIntrayHello command", function()
    plugin.setup()

    assert.is_not_nil(created_commands.PiIntrayHello)
    assert.equals("Print pi-intray hello world", created_commands.PiIntrayHello.opts.desc)
  end)

  it("notifies hello world when command runs", function()
    plugin.setup()

    created_commands.PiIntrayHello.callback()

    assert.same({ "Hello from pi-intray.nvim" }, notifications)
  end)
end)
